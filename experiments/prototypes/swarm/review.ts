// A prototype review by a swarm of cheap agents. The diff is cut into chunks, and each
// chunk gets one agent per chunk task; a few global passes cover the whole change.
// Their findings are merged, checked by several verifiers that vote, and ranked.
//
// Turned on with RB_CONFIG_SWARM=on. The swarm's own settings:
//   RB_CONFIG_SWARM_SPLIT  task (one agent per chunk and task, the default) or chunk (one agent per chunk with every chunk task)
//   RB_CONFIG_SWARM_CHUNKS the most chunks to cut the diff into, 1 to 40, default 10
//   RB_CONFIG_SWARM_VOTES  verifiers per batch of findings, 0 to 5, default 3; 0 skips verification
//   RB_CONFIG_SWARM_TASKS  a comma-separated subset of the task names, default all
//   RB_CONFIG_SWARM_MERGE  on (a model groups repeats before verification, the default) or off (the word-based merge only)
//   RB_CONFIG_SWARM_TARGET seconds the whole review should take, 30 to 780, or 0 (the default) to use the benchmark's budget
//                          as before. A target turns on the fast pace: short agents, slow calls duplicated, one-turn verifiers.
//   RB_CONFIG_SWARM_SORT   latency or throughput asks OpenRouter to route every call by it; unset leaves routing alone
//   RB_CONFIG_SWARM_EFFORT reasoning effort for the swarm's calls, such as low; unset uses RB_CONFIG_EFFORT
//   RB_CONFIG_SWARM_REASONING_TOKENS the most tokens a swarm call may reason for, 100 to 32000; replaces the effort
//   RB_CONFIG_SWARM_CONTEXT basic (the default) or rich: chunk agents also get the code around each use of a changed
//                          name, the definitions of what the chunk calls, matching tests, and the code before the change
//
// Every run writes swarm.json beside the findings file: the chunks, each agent's
// findings and checklist, what the merge folded together, each verifier's vote and
// reason, and what the cap cut. With the transcripts and context.json, a missed
// finding can be traced to the step that lost it.
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runAgent, type SecondLook } from "../../../src/agent.ts";
import type { Config } from "../../../src/config.ts";
import { applyVerdicts, dedupe, normalizeCandidates, parseDiff, parseVerdicts, toOutput, type Candidate, type Verdict } from "../../../src/findings.ts";
import type { Chat } from "../../../src/llm.ts";
import { diffInPrompt, submitVerdicts, verifierPrompt } from "../../../src/prompts.ts";
import { loadPullRequest, loadRules, type ReviewContext, type ReviewOutcome } from "../../../src/review.ts";
import { Workspace } from "../../../src/tools.ts";
import { mergeRepeats, type MergeResult } from "./merge.ts";
import { chunk, chunkContext, chunkSymbols, describeChunk, findMentions, numbered, splitDiff, units } from "./chunks.ts";
import { chunkPrompt, globalPrompt, sharedSection, snippetsSection, submitFastReview, submitSwarmReview, SWARM_SYSTEM, SWARM_VERIFIER_SYSTEM } from "./prompts.ts";
import { calledNames, findDefinitions, findingEvidence, namesInFinding, richContext } from "./context.ts";
import { CHUNK_TASKS, DEFAULT_TASK_NAMES, GLOBAL_TASKS, TASK_NAMES, type SwarmTask } from "./tasks.ts";

const VERIFY_BATCH = 12;
/** The most checkout files listed when looking for tests that match the changed files. */
const MAX_INDEXED_FILES = 20_000;
/** Lines of code shown above and below a finding to a verifier that has no time to read files. */
const SNIPPET_LINES = 15;

/** How the swarm spends its time. The normal pace fills the benchmark's budget; the fast pace aims at a target. */
export interface Pace {
  /** Shares of the time available by which the review agents and the whole swarm must be done. */
  reviewShare: number;
  finishShare: number;
  chunkTurns: number;
  globalTurns: number;
  verifyTurns: number;
  /** Model calls in flight at once, across the whole swarm. */
  concurrency: number;
  /** A cheap model answers one turn in seconds, so a call this slow has stalled and is cut off and retried. */
  callTimeoutMs: number;
  /** A call still running after this long is sent again, and the first answer wins; 0 never sends it again. */
  hedgeMs: number;
  /** An agent that would start with less review time than this left is skipped; it could only skim. */
  minStartMs: number;
  /** A failed agent is run again in a new conversation when this much review time is left. */
  minRetryMs: number;
  /** The longest the model merge may take, so verification keeps its time. */
  mergeMs: number;
  minVerifyMs: number;
  /** Time each agent keeps back for its submission; null keeps the tool loop's default. */
  wrapUpMs: number | null;
}

export const NORMAL_PACE: Pace = {
  reviewShare: 0.6, finishShare: 0.92, chunkTurns: 10, globalTurns: 16, verifyTurns: 12, concurrency: 16,
  callTimeoutMs: 90_000, hedgeMs: 0, minStartMs: 120_000, minRetryMs: 180_000, mergeMs: 120_000, minVerifyMs: 60_000, wrapUpMs: null,
};

/**
 * The pace for a review that must end within `seconds`. Every agent starts at once and may
 * spend nearly the whole review window on its first answer, because answering from the
 * context takes one long call. A call that reasons is sent again only when it runs past
 * 40% of the target, which a healthy answer rarely does. Without reasoning a call answers
 * in seconds, so one still running after a sixth of the target has stalled and is sent
 * again then. Verifiers decide in one turn from the code shown.
 */
export function fastPace(seconds: number, reasoning = true): Pace {
  const ms = seconds * 1000;
  const reviewShare = 0.65;
  return {
    reviewShare, finishShare: 0.92, chunkTurns: 6, globalTurns: 6, verifyTurns: 1, concurrency: 64,
    callTimeoutMs: Math.round(ms * reviewShare), hedgeMs: Math.round(reasoning ? ms * 0.4 : ms / 6), minStartMs: Math.round(ms * 0.3), minRetryMs: Infinity,
    mergeMs: Math.round(ms * 0.15), minVerifyMs: Math.round(ms * 0.12), wrapUpMs: Math.round(ms * 0.1),
  };
}

/**
 * The second look of a fast agent. Its first findings are already in, so it reads only to
 * settle what the context left open, and every round's findings are kept.
 */
export const FAST_SECOND_LOOK: SecondLook = {
  message: (round) => round > 3 ? null
    : "Your findings so far are saved. If a step of your task needs code you have not seen, such as a caller, a definition or a test, read it now with several reads in one turn. Then call submit_review again with only new findings, or with an empty list. You may be stopped at any time, so do not repeat findings you already submitted.",
  combine: (submissions) => ({
    findings: submissions.flatMap((submission) => Array.isArray(submission.findings) ? submission.findings : []),
    checked: submissions.flatMap((submission) => Array.isArray(submission.checked) ? submission.checked : []),
  }),
};

export interface SwarmSettings {
  split: "task" | "chunk";
  chunks: number;
  votes: number;
  tasks: string[];
  merge: boolean;
  /** Seconds the review should take; 0 uses the benchmark's budget. */
  target: number;
  /** Seconds after which the review is cut off; the target when 0. Agents still aim at the target. */
  limit: number;
  /** OpenRouter providers allowed to serve the swarm's calls; all when empty. */
  providers: string[];
  sort: "latency" | "throughput" | null;
  effort: string | null;
  reasoningTokens: number | null;
  context: "basic" | "rich";
  /** With rich context, also shows a one-turn verifier where the names in each finding are used. */
  evidence: boolean;
}

type Env = Record<string, string | undefined>;

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

export function swarmSettings(env: Env): SwarmSettings {
  const split = env.RB_CONFIG_SWARM_SPLIT?.trim() || "task";
  if (split !== "task" && split !== "chunk") throw new Error("RB_CONFIG_SWARM_SPLIT must be task or chunk");
  const tasks = env.RB_CONFIG_SWARM_TASKS?.trim() ? env.RB_CONFIG_SWARM_TASKS.split(",").map((name) => name.trim()).filter(Boolean) : DEFAULT_TASK_NAMES;
  for (const name of tasks) {
    if (!TASK_NAMES.includes(name)) throw new Error(`RB_CONFIG_SWARM_TASKS names an unknown task "${name}"; the choices are ${TASK_NAMES.join(", ")}`);
  }
  const merge = env.RB_CONFIG_SWARM_MERGE?.trim() || "on";
  if (merge !== "on" && merge !== "off") throw new Error("RB_CONFIG_SWARM_MERGE must be on or off");
  const target = integer(env, "RB_CONFIG_SWARM_TARGET", 0, 0, 780);
  if (target && target < 30) throw new Error("RB_CONFIG_SWARM_TARGET must be 0 or from 30 to 780");
  const limit = integer(env, "RB_CONFIG_SWARM_LIMIT", 0, 0, 780);
  if (limit && (!target || limit < target)) throw new Error("RB_CONFIG_SWARM_LIMIT needs RB_CONFIG_SWARM_TARGET and must not be below it");
  const providers = (env.RB_CONFIG_SWARM_PROVIDERS ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  const sort = env.RB_CONFIG_SWARM_SORT?.trim() || null;
  if (sort !== null && sort !== "latency" && sort !== "throughput") throw new Error("RB_CONFIG_SWARM_SORT must be latency or throughput");
  const effort = env.RB_CONFIG_SWARM_EFFORT?.trim() || null;
  if (effort !== null && !["none", "minimal", "low", "medium", "high"].includes(effort)) throw new Error("RB_CONFIG_SWARM_EFFORT must be none, minimal, low, medium or high");
  const reasoningTokens = integer(env, "RB_CONFIG_SWARM_REASONING_TOKENS", 0, 0, 32_000) || null;
  if (reasoningTokens !== null && reasoningTokens < 100) throw new Error("RB_CONFIG_SWARM_REASONING_TOKENS must be from 100 to 32000");
  const context = env.RB_CONFIG_SWARM_CONTEXT?.trim() || "basic";
  if (context !== "basic" && context !== "rich") throw new Error("RB_CONFIG_SWARM_CONTEXT must be basic or rich");
  const evidence = env.RB_CONFIG_SWARM_EVIDENCE?.trim() || "on";
  if (evidence !== "on" && evidence !== "off") throw new Error("RB_CONFIG_SWARM_EVIDENCE must be on or off");
  return {
    evidence: evidence === "on",
    limit,
    providers,
    target,
    sort,
    effort,
    reasoningTokens,
    context,
    merge: merge === "on",
    split,
    chunks: integer(env, "RB_CONFIG_SWARM_CHUNKS", 10, 1, 40),
    votes: integer(env, "RB_CONFIG_SWARM_VOTES", 3, 0, 5),
    tasks,
  };
}

export function describeSwarm(settings: SwarmSettings): string {
  return `swarm_split=${settings.split} swarm_chunks=${settings.chunks} swarm_votes=${settings.votes} swarm_tasks=${settings.tasks.join(",")} swarm_merge=${settings.merge ? "on" : "off"} swarm_target=${settings.target || "budget"} swarm_limit=${settings.limit || "target"} swarm_providers=${settings.providers.join(",") || "any"} swarm_sort=${settings.sort ?? "default"} swarm_effort=${settings.effort ?? "default"} swarm_reasoning_tokens=${settings.reasoningTokens ?? "default"} swarm_context=${settings.context} swarm_evidence=${settings.evidence ? "on" : "off"}`;
}

/** Runs at most `size` of the given jobs at a time. */
function pool(size: number): <T>(job: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async (job) => {
    if (running >= size) await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
    try {
      return await job();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };
}

/**
 * Sends a call again when it has run for `afterMs`, and returns whichever answer comes
 * first. Most slow calls have stalled at the provider, and a new call usually lands on a
 * healthy one. Both calls are paid for. `sent` counts the calls sent again.
 */
export function hedge(chat: Chat, afterMs: number, sent: { count: number }): Chat {
  return async (request) => {
    const first = chat(request);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<"slow">((resolve) => { timer = setTimeout(resolve, afterMs, "slow"); });
    const settled = await Promise.race([first.then((message) => ({ message }), (error: unknown) => ({ error })), slow]);
    clearTimeout(timer);
    if (settled !== "slow") {
      if ("error" in settled) throw settled.error;
      return settled.message;
    }
    sent.count += 1;
    const second = chat({ ...request, timeoutMs: Math.max(1_000, request.timeoutMs - afterMs) });
    try {
      return await Promise.any([first, second]);
    } catch (error) {
      throw error instanceof AggregateError ? error.errors[0] : error;
    }
  };
}

/**
 * Combines several verifiers' verdicts into one per finding. A finding is rejected when
 * most of the verifiers that answered rejected it, and is a duplicate when most named
 * the same finding it repeats. A finding no verifier answered for counts as uncertain.
 */
export function tally(ids: string[], ballots: Verdict[][]): Verdict[] {
  return ids.map((id) => {
    const votes = ballots.map((ballot) => ballot.find((verdict) => verdict.id === id)).filter((verdict) => verdict !== undefined);
    if (!votes.length) return { id, verdict: "uncertain", duplicateOf: null };
    const rejected = votes.filter((vote) => vote.verdict === "rejected").length * 2 > votes.length;
    const targets = new Map<string, number>();
    for (const vote of votes) if (vote.duplicateOf) targets.set(vote.duplicateOf, (targets.get(vote.duplicateOf) ?? 0) + 1);
    const duplicateOf = [...targets].find(([, count]) => count * 2 > votes.length)?.[0] ?? null;
    return { id, verdict: rejected ? "rejected" : "confirmed", duplicateOf };
  });
}

/**
 * Most severe first; within a severity, the findings more agents reported first, then
 * the most confident. Agreement between independent agents is the swarm's best evidence.
 */
export function rankBySupport(candidates: Candidate[], support: Map<string, number>, max: number): Candidate[] {
  const severity = { high: 0, medium: 1, low: 2 } as const;
  return candidates
    .map((candidate, position) => ({ candidate, position }))
    .sort((a, b) =>
      severity[a.candidate.severity] - severity[b.candidate.severity]
      || (support.get(b.candidate.id) ?? 1) - (support.get(a.candidate.id) ?? 1)
      || b.candidate.confidence - a.candidate.confidence
      || a.position - b.position)
    .slice(0, max)
    .map(({ candidate }) => candidate);
}

/** Splits findings into batches of the same files, so repeats of one problem land in the same batch. */
function batches(candidates: Candidate[]): Candidate[][] {
  const byFile = new Map<string, Candidate[]>();
  for (const candidate of candidates) byFile.set(candidate.file, [...(byFile.get(candidate.file) ?? []), candidate]);
  const result: Candidate[][] = [];
  for (const group of byFile.values()) {
    const last = result.at(-1);
    if (last && last.length + group.length <= VERIFY_BATCH) last.push(...group);
    else for (let index = 0; index < group.length; index += VERIFY_BATCH) result.push(group.slice(index, index + VERIFY_BATCH));
  }
  return result;
}

/** Everything a later analysis of misses needs, written as swarm.json beside the findings file. */
interface Trace {
  settings: SwarmSettings & { model: string; verifier: string };
  chunks: Array<{ id: string; where: string; units: Array<{ path: string; hunks: Array<[number, number]> }>; symbols: string[]; mentions: Record<string, number> }>;
  agents: Array<{ caller: string; tasks: string[]; status: "ok" | "empty" | "failed" | "skipped"; attempts: number; errors: string[]; ms: number; submitted: number; kept: number; checked: unknown[] }>;
  /** mergedInto is the proposal the word-based merge kept instead; groupedInto is the finding the model merge kept instead. */
  proposals: Array<Candidate & { caller: string; mergedInto: string | null; groupedInto: string | null; findingId: string | null }>;
  merges: MergeResult["batches"];
  verification: Array<{ findingId: string; batch: number; ballots: Array<{ voter: string; verdict: string | null; reason: string | null; duplicateOf: string | null }>; result: Verdict; kept: boolean }>;
  final: Array<{ findingId: string; rank: number; file: string; startLine: number; endLine: number; severity: string; kind: string; title: string; support: number; from: string[] }>;
  cutByCap: string[];
  /** setupMs is the time spent cutting the diff and gathering context, before any agent starts. */
  timing: { setupMs: number; reviewMs: number; mergeMs: number; verifyMs: number; totalMs: number };
  /** Model calls sent a second time because the first was slow. */
  hedged: number;
  /** Every model call: who made it, when it started and how long it took, and how much it reasoned and wrote. */
  calls: Array<{ caller: string; startMs: number; ms: number; ok: boolean; reasoningChars: number; outputChars: number; forced: boolean; provider: string | null }>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function swarmReview(config: Config, chat: Chat, log: (message: string) => void): Promise<ReviewOutcome> {
  const settings = swarmSettings(process.env);
  log(`swarm settings: ${describeSwarm(settings)}`);
  const trace: Trace = {
    settings: { ...settings, model: config.models[0]!, verifier: config.verifierModel },
    chunks: [], agents: [], proposals: [], merges: [], verification: [], final: [], cutByCap: [], timing: { setupMs: 0, reviewMs: 0, mergeMs: 0, verifyMs: 0, totalMs: 0 }, hedged: 0, calls: [],
  };
  const started = Date.now();
  // The trace is for analysis only, so failing to write it never fails the review. It is
  // written after each phase too, so a run the benchmark kills still leaves what it did.
  const save = async (): Promise<void> => {
    trace.timing.totalMs = Date.now() - started;
    await writeFile(join(dirname(config.outPath), "swarm.json"), `${JSON.stringify(trace)}\n`).catch((error) => log(`could not write swarm.json: ${describe(error)}`));
  };
  try {
    return await swarm(config, chat, log, settings, trace, save);
  } finally {
    await save();
  }
}

async function swarm(config: Config, baseChat: Chat, log: (message: string) => void, settings: SwarmSettings, trace: Trace, save: () => Promise<void>): Promise<ReviewOutcome> {
  const started = Date.now();
  const target = settings.target ? Math.min(settings.target * 1000, config.budgetMs) : 0;
  // With a limit, the deadlines and cut-offs come from the limit, so a slow call is not lost at
  // the target, while agents are still told the target and slow calls are resent as soon.
  const limit = settings.limit ? Math.min(settings.limit * 1000, config.budgetMs) : target;
  const reasoning = settings.effort !== "none";
  const pace = target ? { ...fastPace(limit / 1000, reasoning), hedgeMs: fastPace(target / 1000, reasoning).hedgeMs } : NORMAL_PACE;
  const available = limit || config.budgetMs;
  const reviewDeadline = started + available * pace.reviewShare;
  let finishDeadline = started + available * pace.finishShare;
  const model = config.models[0]!;
  const run = pool(pace.concurrency);
  const hedges = { count: 0 };
  // Each call is timed for the trace, so a slow review shows which calls were slow and why.
  const timed: Chat = async (request) => {
    const callStarted = Date.now();
    const record = { caller: request.caller ?? "", startMs: callStarted - started, ms: 0, ok: false, reasoningChars: 0, outputChars: 0, forced: Boolean(request.forceTool), provider: null as string | null };
    trace.calls.push(record);
    try {
      const reply = await baseChat({
        ...request, ...(settings.sort ? { providerSort: settings.sort } : {}), ...(settings.providers.length ? { providers: settings.providers } : {}), ...(settings.effort ? { effort: settings.effort } : {}),
        ...(settings.reasoningTokens ? { reasoningTokens: settings.reasoningTokens } : {}),
      });
      record.ok = true;
      record.provider = reply.provider ?? null;
      record.reasoningChars = Array.isArray(reply.reasoning_details)
        ? reply.reasoning_details.reduce((sum: number, item: { text?: unknown }) => sum + (typeof item?.text === "string" ? item.text.length : 0), 0) : 0;
      record.outputChars = (reply.content?.length ?? 0) + (reply.tool_calls ?? []).reduce((sum, call) => sum + call.function.arguments.length, 0);
      return reply;
    } finally {
      record.ms = Date.now() - callStarted;
    }
  };
  const chat = pace.hedgeMs ? hedge(timed, pace.hedgeMs, hedges) : timed;
  const fastSeconds = target ? Math.round(target / 1000) : 0;
  const wrapUp = pace.wrapUpMs === null ? {} : { wrapUpMs: pace.wrapUpMs };

  const workspace = new Workspace(config.repoDir, config.diffPath, config.base);
  const [pr, diff, rules] = await Promise.all([loadPullRequest(config), workspace.diff(), loadRules(workspace)]);
  const changed = parseDiff(diff);
  const chunks = chunk(units(splitDiff(diff)), settings.chunks);
  const mentions = await findMentions(config.repoDir, [...new Set(chunks.flatMap(chunkSymbols))]);
  const shared = sharedSection(pr, changed, rules);
  const headFile = (path: string): Promise<string | null> => workspace.headFile(path);
  const rich = settings.context === "rich" ? {
    headFile, baseFile: (path: string) => workspace.baseFile(path), mentions,
    definitions: await findDefinitions(config.repoDir, [...new Set(chunks.flatMap(calledNames))]),
    allFiles: await workspace.allFiles(MAX_INDEXED_FILES),
  } : null;

  const chunkTasks = CHUNK_TASKS.filter((task) => settings.tasks.includes(task.name));
  const globalTasks = GLOBAL_TASKS.filter((task) => settings.tasks.includes(task.name));
  const jobs: Array<{ caller: string; tasks: SwarmTask[]; prompt: (fast: boolean) => Promise<string>; turns: (fast: boolean) => number }> = [];
  for (const piece of chunks) {
    const where = describeChunk(piece);
    log(`chunk ${piece.id}: ${where}`);
    const symbols = chunkSymbols(piece);
    trace.chunks.push({
      id: piece.id, where, symbols,
      units: piece.units.map((unit) => ({ path: unit.path, hunks: unit.hunks.map((hunk): [number, number] => [hunk.start, hunk.end]) })),
      mentions: Object.fromEntries(symbols.map((name) => [name, mentions.get(name)?.length ?? 0])),
    });
    const context = rich
      ? Promise.all([chunkContext(piece, headFile, mentions), richContext(piece, rich)]).then((parts) => parts.filter(Boolean).join("\n\n"))
      : chunkContext(piece, headFile, mentions);
    const groups = settings.split === "task" ? chunkTasks.map((task) => [task]) : chunkTasks.length ? [chunkTasks] : [];
    for (const tasks of groups) {
      const turns = (fast: boolean) => Math.min(config.maxTurns, fast ? fastPace(fastSeconds).chunkTurns : NORMAL_PACE.chunkTurns * tasks.length);
      jobs.push({ caller: `${piece.id}/${tasks.length > 1 ? "all" : tasks[0]!.name}`, tasks, turns, prompt: async (fast) => chunkPrompt(shared, tasks, turns(fast), where, await context, fast ? fastSeconds : 0) });
    }
  }
  for (const task of globalTasks) {
    const turns = (fast: boolean) => Math.min(config.maxTurns, fast ? fastPace(fastSeconds).globalTurns : NORMAL_PACE.globalTurns);
    jobs.push({ caller: `global/${task.name}`, tasks: [task], turns, prompt: async (fast) => globalPrompt(shared, task, turns(fast), diff, fast ? fastSeconds : 0) });
  }
  trace.timing.setupMs = Date.now() - started;
  log(`swarm: ${chunks.length} chunk(s), ${jobs.length} agent(s) with ${model}, set up in ${Math.round(trace.timing.setupMs / 1000)}s`);

  const context: ReviewContext = { diffInPrompt: diffInPrompt(diff), readers: [] };
  type Job = (typeof jobs)[number];
  /** Runs one agent to `deadline` at `agentPace`, and records it in the trace. */
  const runJob = (job: Job, deadline: number, agentPace: Pace, fast: boolean) => run(async () => {
    const agentStarted = Date.now();
    const entry: Trace["agents"][number] = { caller: job.caller, tasks: job.tasks.map((task) => task.name), status: "failed", attempts: 0, errors: [], ms: 0, submitted: 0, kept: 0, checked: [] };
    trace.agents.push(entry);
    try {
      if (deadline - Date.now() < agentPace.minStartMs) {
        entry.status = "skipped";
        throw new Error("skipped: too little review time was left when its turn came");
      }
      const prompt = await job.prompt(fast);
      for (;;) {
        entry.attempts += 1;
        const caller = entry.attempts > 1 ? `${job.caller}#${entry.attempts}` : job.caller;
        try {
          const seatWorkspace = new Workspace(config.repoDir, config.diffPath, config.base);
          context.readers.push({ caller, reads: seatWorkspace.reads });
          const submission = await runAgent({
            chat, model, system: SWARM_SYSTEM, prompt, workspace: seatWorkspace, submit: fast ? submitFastReview : submitSwarmReview,
            deadline, maxTurns: job.turns(fast), log, caller, attemptTimeoutMs: agentPace.callTimeoutMs,
            ...(agentPace.wrapUpMs === null ? {} : { wrapUpMs: agentPace.wrapUpMs }),
            // A fast agent is asked to hand in findings from its context first, so being cut off later loses little.
            ...(fast ? { secondLook: FAST_SECOND_LOOK } : {}),
          });
          const candidates = await normalizeCandidates(submission.findings, { seat: job.caller, repoDir: config.repoDir, changed, headFile, log });
          entry.status = "ok";
          entry.submitted = Array.isArray(submission.findings) ? submission.findings.length : 0;
          entry.kept = candidates.length;
          entry.checked = Array.isArray(submission.checked) ? submission.checked : [];
          log(`${job.caller}: ${candidates.length} finding(s), ${entry.checked.length} item(s) checked`);
          if (!candidates.length) entry.status = "empty";
          return candidates;
        } catch (error) {
          entry.errors.push(describe(error));
          // One more try in a new conversation, since most failures are a stalled or refused call, not the task.
          if (entry.attempts >= 2 || deadline - Date.now() < agentPace.minRetryMs) throw error;
          log(`${job.caller} failed, trying once more: ${describe(error)}`);
        }
      }
    } finally {
      entry.ms = Date.now() - agentStarted;
    }
  });

  const outcomes = await Promise.allSettled(jobs.map((job) => runJob(job, reviewDeadline, pace, target > 0)));
  // A fast review that lost most of its agents runs them again at the normal pace. It misses
  // its target on this pull request rather than hand in a review that is mostly blind. An agent
  // that found nothing counts as lost here, because a fast agent cut off early also hands in nothing.
  const lost = outcomes.flatMap((outcome, index) => outcome.status === "rejected" || !outcome.value.length ? [index] : []);
  if (target && lost.length * 2 > jobs.length) {
    const normalDeadline = started + config.budgetMs * NORMAL_PACE.reviewShare;
    finishDeadline = Math.max(finishDeadline, started + config.budgetMs * NORMAL_PACE.finishShare);
    log(`swarm: ${lost.length} of ${jobs.length} agent(s) missed the target; running them again at the normal pace`);
    const again = await Promise.allSettled(lost.map((index) => runJob(jobs[index]!, normalDeadline, NORMAL_PACE, false)));
    lost.forEach((index, position) => { outcomes[index] = again[position]!; });
  }

  const proposals: Candidate[] = [];
  let succeeded = 0;
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === "fulfilled") {
      succeeded += 1;
      proposals.push(...outcome.value);
    } else {
      log(`${jobs[index]!.caller} failed: ${describe(outcome.reason)}`);
    }
  }
  trace.timing.reviewMs = Date.now() - started;
  await save();
  // An empty list would claim the change is clean, so a run where no agent finished must fail instead.
  if (!succeeded) throw new Error("no swarm agent completed");
  // A review missing most of its agents is mostly blind. On the first attempt, fail so the
  // benchmark retries; a later attempt keeps what it has rather than fail the whole run.
  if (succeeded * 2 < jobs.length && config.attempt < 2) throw new Error(`only ${succeeded} of ${jobs.length} swarm agents completed`);
  log(`swarm: ${succeeded} of ${jobs.length} agent(s) finished, ${proposals.length} finding(s) proposed`);

  // Ids from different agents are long, so each merged finding gets a short one before verification.
  const mergedInto = new Map<string, string>();
  const merged = dedupe(proposals, (dropped, kept) => mergedInto.set(dropped.id, kept.id));
  const findingIds = new Map(merged.map((candidate, index) => [candidate.id, `f${index + 1}`]));
  // A finding kept at first can lose its place to a later one, so follow the chain to the survivor.
  const survivorOf = (id: string): string => {
    let current = id;
    for (let hops = 0; mergedInto.has(current) && hops < proposals.length; hops += 1) current = mergedInto.get(current)!;
    return current;
  };
  trace.proposals = proposals.map((candidate) => ({
    ...candidate, caller: candidate.seat,
    mergedInto: mergedInto.has(candidate.id) ? survivorOf(candidate.id) : null,
    groupedInto: null,
    findingId: findingIds.get(survivorOf(candidate.id)) ?? null,
  }));
  let survivors = merged.map((candidate) => ({ ...candidate, id: findingIds.get(candidate.id)! }));
  log(`word merge kept ${survivors.length} of ${proposals.length} finding(s)`);

  let verified = false;
  const verifyStarted = Date.now();
  if (config.verify !== "off" && settings.votes > 0 && survivors.length && finishDeadline - Date.now() >= pace.minVerifyMs) {
    const groups = batches(survivors);
    // A one-turn verifier cannot read files, so it is shown the code around each finding,
    // and with rich context also where the names each finding mentions are used.
    const evidenceMentions = rich && settings.evidence && pace.verifyTurns === 1
      ? await findMentions(config.repoDir, [...new Set(survivors.flatMap((candidate) => namesInFinding(`${candidate.title} ${candidate.detail}`)))])
      : null;
    const prompts = await Promise.all(groups.map(async (group) => {
      const base = verifierPrompt(pr, changed, diff, group);
      if (pace.verifyTurns > 1) return base;
      const snippets = await Promise.all(group.map(async (candidate) => {
        const text = await headFile(candidate.file);
        if (text === null) return null;
        const first = Math.max(1, candidate.startLine - SNIPPET_LINES);
        const last = candidate.endLine + SNIPPET_LINES;
        return { id: candidate.id, file: candidate.file, first, last, text: numbered(text, first, last) };
      }));
      const evidence = evidenceMentions ? await findingEvidence(group, evidenceMentions, headFile) : "";
      return [base, snippetsSection(snippets.filter((snippet) => snippet !== null)), ...(evidence ? [evidence] : [])].join("\n\n");
    }));
    type Ballot = { voter: string; verdicts: Verdict[]; reasons: Map<string, string> };
    const ballots = await Promise.all(groups.map((group, batch) => Promise.all(
      Array.from({ length: settings.votes }, (_, vote) => run(async (): Promise<Ballot> => {
        // Named "verifier" so the coverage script counts these as checkers, not reviewers.
        const voter = `verifier/b${batch + 1}v${vote + 1}`;
        // A vote that starts too late is no vote; the tally counts only the votes cast.
        if (finishDeadline - Date.now() < pace.minVerifyMs) {
          log(`${voter} skipped: too little time was left when its turn came`);
          return { voter, verdicts: [], reasons: new Map() };
        }
        const verifierWorkspace = new Workspace(config.repoDir, config.diffPath, config.base);
        context.readers.push({ caller: voter, reads: verifierWorkspace.reads });
        try {
          const submission = await runAgent({
            chat, model: config.verifierModel, system: SWARM_VERIFIER_SYSTEM, prompt: prompts[batch]!,
            workspace: verifierWorkspace, submit: submitVerdicts, deadline: finishDeadline, maxTurns: Math.min(config.maxTurns, pace.verifyTurns), log, caller: voter,
            attemptTimeoutMs: pace.callTimeoutMs, ...wrapUp,
          });
          const reasons = new Map<string, string>();
          for (const item of Array.isArray(submission.verdicts) ? submission.verdicts : []) {
            if (item && typeof item.id === "string" && typeof item.reason === "string") reasons.set(item.id, item.reason);
          }
          return { voter, verdicts: parseVerdicts(submission.verdicts), reasons };
        } catch (error) {
          log(`${voter} failed: ${describe(error)}`);
          return { voter, verdicts: [], reasons: new Map() };
        }
      })),
    )));
    const verdicts = groups.flatMap((group, batch) => tally(group.map((candidate) => candidate.id), ballots[batch]!.map((ballot) => ballot.verdicts)));
    const before = survivors;
    survivors = applyVerdicts(survivors, verdicts, config.verify === "strict");
    const keptIds = new Set(survivors.map((candidate) => candidate.id));
    const results = new Map(verdicts.map((verdict) => [verdict.id, verdict]));
    groups.forEach((group, batch) => {
      for (const candidate of group) {
        trace.verification.push({
          findingId: candidate.id, batch: batch + 1, result: results.get(candidate.id)!, kept: keptIds.has(candidate.id),
          ballots: ballots[batch]!.map(({ voter, verdicts: cast, reasons }) => {
            const verdict = cast.find((item) => item.id === candidate.id);
            return { voter, verdict: verdict?.verdict ?? null, reason: reasons.get(candidate.id) ?? null, duplicateOf: verdict?.duplicateOf ?? null };
          }),
        });
      }
    });
    verified = ballots.some((group) => group.some((ballot) => ballot.verdicts.length));
    log(`verification kept ${survivors.length} of ${before.length} finding(s)`);
  } else if (survivors.length) {
    log("verification skipped");
  }
  trace.timing.verifyMs = Date.now() - verifyStarted;

  // Repeats are folded only among the findings the verifiers kept, and only when more are
  // left than the cap. Each finding is verified on its own first, so a group never stands or
  // falls on one member's votes, and a review under the cap keeps every finding it found.
  const mergeStarted = Date.now();
  if (settings.merge && survivors.length > config.maxFindings) {
    const mergeDeadline = Math.min(Date.now() + pace.mergeMs, finishDeadline);
    if (mergeDeadline - Date.now() >= Math.min(30_000, pace.mergeMs / 2)) {
      const result = await mergeRepeats(survivors, {
        chat, model, deadline: mergeDeadline, attemptTimeoutMs: pace.callTimeoutMs, run, log,
      });
      trace.merges = result.batches;
      for (const proposal of trace.proposals) {
        const kept = proposal.findingId ? result.into.get(proposal.findingId) : undefined;
        if (kept) {
          proposal.groupedInto = kept;
          proposal.findingId = kept;
        }
      }
      log(`model merge kept ${result.kept.length} of ${survivors.length} finding(s)`);
      survivors = result.kept;
    } else {
      log("model merge skipped: too little time is left");
    }
  }
  trace.timing.mergeMs = Date.now() - mergeStarted;
  trace.hedged = hedges.count;
  if (hedges.count) log(`swarm: ${hedges.count} slow call(s) sent again`);
  // How many agents reported each finding, counting an agent's retry as the same agent.
  const support = new Map<string, number>();
  for (const candidate of survivors) {
    support.set(candidate.id, new Set(trace.proposals.filter((proposal) => proposal.findingId === candidate.id).map((proposal) => proposal.caller)).size);
  }
  await save();

  const ranked = rankBySupport(survivors, support, config.maxFindings);
  const rankedIds = new Set(ranked.map((candidate) => candidate.id));
  trace.cutByCap = survivors.filter((candidate) => !rankedIds.has(candidate.id)).map((candidate) => candidate.id);
  trace.final = ranked.map((candidate, index) => ({
    findingId: candidate.id, rank: index + 1, file: candidate.file, startLine: candidate.startLine, endLine: candidate.endLine,
    severity: candidate.severity, kind: candidate.kind, title: candidate.title, support: support.get(candidate.id) ?? 1,
    from: trace.proposals.filter((proposal) => proposal.findingId === candidate.id).map((proposal) => proposal.id),
  }));
  // In agent mode each message starts with how severe the finding is and how many checks
  // confirmed it, so the agent reading a long list can choose what to act on first.
  const checks = new Map(trace.verification.map((entry) => [entry.findingId, entry.ballots.filter((ballot) => ballot.verdict !== null)]));
  const label = (candidate: Candidate): string => {
    const cast = checks.get(candidate.id) ?? [];
    const confirmed = cast.filter((ballot) => ballot.verdict === "confirmed").length;
    return `[${candidate.severity} severity, ${cast.length ? `confirmed by ${confirmed} of ${cast.length} checks` : "not checked"}] `;
  };
  return {
    findings: ranked.map((candidate) => {
      const output = toOutput(candidate, config.agent);
      return config.mode === "agent" ? { ...output, message: label(candidate) + output.message } : output;
    }),
    ranked, proposed: proposals.length, verified, fit: null, context,
  };
}
