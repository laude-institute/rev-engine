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
//
// Every run writes swarm.json beside the findings file: the chunks, each agent's
// findings and checklist, what the merge folded together, each verifier's vote and
// reason, and what the cap cut. With the transcripts and context.json, a missed
// finding can be traced to the step that lost it.
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runAgent } from "../../../src/agent.ts";
import type { Config } from "../../../src/config.ts";
import { applyVerdicts, dedupe, normalizeCandidates, parseDiff, parseVerdicts, toOutput, type Candidate, type Verdict } from "../../../src/findings.ts";
import type { Chat } from "../../../src/llm.ts";
import { diffInPrompt, submitVerdicts, verifierPrompt } from "../../../src/prompts.ts";
import { loadPullRequest, loadRules, type ReviewContext, type ReviewOutcome } from "../../../src/review.ts";
import { Workspace } from "../../../src/tools.ts";
import { mergeRepeats, type MergeResult } from "./merge.ts";
import { chunk, chunkContext, chunkSymbols, describeChunk, findMentions, splitDiff, units } from "./chunks.ts";
import { chunkPrompt, globalPrompt, sharedSection, submitSwarmReview, SWARM_SYSTEM, SWARM_VERIFIER_SYSTEM } from "./prompts.ts";
import { CHUNK_TASKS, GLOBAL_TASKS, TASK_NAMES, type SwarmTask } from "./tasks.ts";

const REVIEW_SHARE = 0.6;
const FINISH_SHARE = 0.92;
const MIN_VERIFY_MS = 60_000;
const CHUNK_TURNS = 10;
const GLOBAL_TURNS = 16;
const VERIFY_TURNS = 12;
const VERIFY_BATCH = 12;
/** Model calls in flight at once, across the whole swarm. */
const CONCURRENCY = 16;
/** A cheap model answers one turn in seconds, so a call this slow has stalled and is cut off and retried. */
const CALL_TIMEOUT_MS = 90_000;
/** An agent that would start with less review time than this left is skipped; it could only skim. */
const MIN_START_MS = 120_000;
/** A failed agent is run again in a new conversation when this much review time is left. */
const MIN_RETRY_MS = 180_000;
/** The longest the model merge may take, so verification keeps its time. */
const MERGE_MS = 120_000;

export interface SwarmSettings {
  split: "task" | "chunk";
  chunks: number;
  votes: number;
  tasks: string[];
  merge: boolean;
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
  const tasks = env.RB_CONFIG_SWARM_TASKS?.trim() ? env.RB_CONFIG_SWARM_TASKS.split(",").map((name) => name.trim()).filter(Boolean) : TASK_NAMES;
  for (const name of tasks) {
    if (!TASK_NAMES.includes(name)) throw new Error(`RB_CONFIG_SWARM_TASKS names an unknown task "${name}"; the choices are ${TASK_NAMES.join(", ")}`);
  }
  const merge = env.RB_CONFIG_SWARM_MERGE?.trim() || "on";
  if (merge !== "on" && merge !== "off") throw new Error("RB_CONFIG_SWARM_MERGE must be on or off");
  return {
    merge: merge === "on",
    split,
    chunks: integer(env, "RB_CONFIG_SWARM_CHUNKS", 10, 1, 40),
    votes: integer(env, "RB_CONFIG_SWARM_VOTES", 3, 0, 5),
    tasks,
  };
}

export function describeSwarm(settings: SwarmSettings): string {
  return `swarm_split=${settings.split} swarm_chunks=${settings.chunks} swarm_votes=${settings.votes} swarm_tasks=${settings.tasks.join(",")} swarm_merge=${settings.merge ? "on" : "off"}`;
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
  agents: Array<{ caller: string; tasks: string[]; status: "ok" | "failed" | "skipped"; attempts: number; errors: string[]; ms: number; submitted: number; kept: number; checked: unknown[] }>;
  /** mergedInto is the proposal the word-based merge kept instead; groupedInto is the finding the model merge kept instead. */
  proposals: Array<Candidate & { caller: string; mergedInto: string | null; groupedInto: string | null; findingId: string | null }>;
  merges: MergeResult["batches"];
  verification: Array<{ findingId: string; batch: number; ballots: Array<{ voter: string; verdict: string | null; reason: string | null; duplicateOf: string | null }>; result: Verdict; kept: boolean }>;
  final: Array<{ findingId: string; rank: number; file: string; startLine: number; endLine: number; severity: string; kind: string; title: string; support: number; from: string[] }>;
  cutByCap: string[];
  timing: { reviewMs: number; verifyMs: number; totalMs: number };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function swarmReview(config: Config, chat: Chat, log: (message: string) => void): Promise<ReviewOutcome> {
  const settings = swarmSettings(process.env);
  log(`swarm settings: ${describeSwarm(settings)}`);
  const trace: Trace = {
    settings: { ...settings, model: config.models[0]!, verifier: config.verifierModel },
    chunks: [], agents: [], proposals: [], merges: [], verification: [], final: [], cutByCap: [], timing: { reviewMs: 0, verifyMs: 0, totalMs: 0 },
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

async function swarm(config: Config, chat: Chat, log: (message: string) => void, settings: SwarmSettings, trace: Trace, save: () => Promise<void>): Promise<ReviewOutcome> {
  const started = Date.now();
  const reviewDeadline = started + config.budgetMs * REVIEW_SHARE;
  const finishDeadline = started + config.budgetMs * FINISH_SHARE;
  const model = config.models[0]!;
  const run = pool(CONCURRENCY);

  const workspace = new Workspace(config.repoDir, config.diffPath, config.base);
  const [pr, diff, rules] = await Promise.all([loadPullRequest(config), workspace.diff(), loadRules(workspace)]);
  const changed = parseDiff(diff);
  const chunks = chunk(units(splitDiff(diff)), settings.chunks);
  const mentions = await findMentions(config.repoDir, [...new Set(chunks.flatMap(chunkSymbols))]);
  const shared = sharedSection(pr, changed, rules);
  const headFile = (path: string): Promise<string | null> => workspace.headFile(path);

  const chunkTasks = CHUNK_TASKS.filter((task) => settings.tasks.includes(task.name));
  const globalTasks = GLOBAL_TASKS.filter((task) => settings.tasks.includes(task.name));
  const jobs: Array<{ caller: string; tasks: SwarmTask[]; prompt: () => Promise<string>; turns: number }> = [];
  for (const piece of chunks) {
    const where = describeChunk(piece);
    log(`chunk ${piece.id}: ${where}`);
    const symbols = chunkSymbols(piece);
    trace.chunks.push({
      id: piece.id, where, symbols,
      units: piece.units.map((unit) => ({ path: unit.path, hunks: unit.hunks.map((hunk): [number, number] => [hunk.start, hunk.end]) })),
      mentions: Object.fromEntries(symbols.map((name) => [name, mentions.get(name)?.length ?? 0])),
    });
    const context = chunkContext(piece, headFile, mentions);
    const groups = settings.split === "task" ? chunkTasks.map((task) => [task]) : chunkTasks.length ? [chunkTasks] : [];
    for (const tasks of groups) {
      const turns = Math.min(config.maxTurns, CHUNK_TURNS * tasks.length);
      jobs.push({ caller: `${piece.id}/${tasks.length > 1 ? "all" : tasks[0]!.name}`, tasks, turns, prompt: async () => chunkPrompt(shared, tasks, turns, where, await context) });
    }
  }
  for (const task of globalTasks) {
    const turns = Math.min(config.maxTurns, GLOBAL_TURNS);
    jobs.push({ caller: `global/${task.name}`, tasks: [task], turns, prompt: async () => globalPrompt(shared, task, turns, diff) });
  }
  log(`swarm: ${chunks.length} chunk(s), ${jobs.length} agent(s) with ${model}`);

  const context: ReviewContext = { diffInPrompt: diffInPrompt(diff), readers: [] };
  const outcomes = await Promise.allSettled(jobs.map((job) => run(async () => {
    const agentStarted = Date.now();
    const entry: Trace["agents"][number] = { caller: job.caller, tasks: job.tasks.map((task) => task.name), status: "failed", attempts: 0, errors: [], ms: 0, submitted: 0, kept: 0, checked: [] };
    trace.agents.push(entry);
    try {
      if (reviewDeadline - Date.now() < MIN_START_MS) {
        entry.status = "skipped";
        throw new Error("skipped: too little review time was left when its turn came");
      }
      const prompt = await job.prompt();
      for (;;) {
        entry.attempts += 1;
        const caller = entry.attempts > 1 ? `${job.caller}#${entry.attempts}` : job.caller;
        try {
          const seatWorkspace = new Workspace(config.repoDir, config.diffPath, config.base);
          context.readers.push({ caller, reads: seatWorkspace.reads });
          const submission = await runAgent({
            chat, model, system: SWARM_SYSTEM, prompt, workspace: seatWorkspace, submit: submitSwarmReview,
            deadline: reviewDeadline, maxTurns: job.turns, log, caller, attemptTimeoutMs: CALL_TIMEOUT_MS,
          });
          const candidates = await normalizeCandidates(submission.findings, { seat: job.caller, repoDir: config.repoDir, changed, headFile, log });
          entry.status = "ok";
          entry.submitted = Array.isArray(submission.findings) ? submission.findings.length : 0;
          entry.kept = candidates.length;
          entry.checked = Array.isArray(submission.checked) ? submission.checked : [];
          log(`${job.caller}: ${candidates.length} finding(s), ${entry.checked.length} item(s) checked`);
          return candidates;
        } catch (error) {
          entry.errors.push(describe(error));
          // One more try in a new conversation, since most failures are a stalled or refused call, not the task.
          if (entry.attempts >= 2 || reviewDeadline - Date.now() < MIN_RETRY_MS) throw error;
          log(`${job.caller} failed, trying once more: ${describe(error)}`);
        }
      }
    } finally {
      entry.ms = Date.now() - agentStarted;
    }
  })));

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

  if (settings.merge && survivors.length > 1) {
    const mergeDeadline = Math.min(Date.now() + MERGE_MS, finishDeadline - MIN_VERIFY_MS);
    if (mergeDeadline - Date.now() >= 30_000) {
      const result = await mergeRepeats(survivors, {
        chat, model, deadline: mergeDeadline, attemptTimeoutMs: CALL_TIMEOUT_MS, run, log,
        workspace: () => new Workspace(config.repoDir, config.diffPath, config.base),
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
  // How many agents reported each finding, counting an agent's retry as the same agent.
  const support = new Map<string, number>();
  for (const candidate of survivors) {
    support.set(candidate.id, new Set(trace.proposals.filter((proposal) => proposal.findingId === candidate.id).map((proposal) => proposal.caller)).size);
  }
  await save();

  let verified = false;
  const verifyStarted = Date.now();
  if (config.verify !== "off" && settings.votes > 0 && survivors.length && finishDeadline - Date.now() >= MIN_VERIFY_MS) {
    const groups = batches(survivors);
    type Ballot = { voter: string; verdicts: Verdict[]; reasons: Map<string, string> };
    const ballots = await Promise.all(groups.map((group, batch) => Promise.all(
      Array.from({ length: settings.votes }, (_, vote) => run(async (): Promise<Ballot> => {
        // Named "verifier" so the coverage script counts these as checkers, not reviewers.
        const voter = `verifier/b${batch + 1}v${vote + 1}`;
        // A vote that starts too late is no vote; the tally counts only the votes cast.
        if (finishDeadline - Date.now() < MIN_VERIFY_MS) {
          log(`${voter} skipped: too little time was left when its turn came`);
          return { voter, verdicts: [], reasons: new Map() };
        }
        const verifierWorkspace = new Workspace(config.repoDir, config.diffPath, config.base);
        context.readers.push({ caller: voter, reads: verifierWorkspace.reads });
        try {
          const submission = await runAgent({
            chat, model: config.verifierModel, system: SWARM_VERIFIER_SYSTEM, prompt: verifierPrompt(pr, changed, diff, group),
            workspace: verifierWorkspace, submit: submitVerdicts, deadline: finishDeadline, maxTurns: Math.min(config.maxTurns, VERIFY_TURNS), log, caller: voter,
            attemptTimeoutMs: CALL_TIMEOUT_MS,
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
  await save();

  const ranked = rankBySupport(survivors, support, config.maxFindings);
  const rankedIds = new Set(ranked.map((candidate) => candidate.id));
  trace.cutByCap = survivors.filter((candidate) => !rankedIds.has(candidate.id)).map((candidate) => candidate.id);
  trace.final = ranked.map((candidate, index) => ({
    findingId: candidate.id, rank: index + 1, file: candidate.file, startLine: candidate.startLine, endLine: candidate.endLine,
    severity: candidate.severity, kind: candidate.kind, title: candidate.title, support: support.get(candidate.id) ?? 1,
    from: trace.proposals.filter((proposal) => proposal.findingId === candidate.id).map((proposal) => proposal.id),
  }));
  return {
    findings: ranked.map((candidate) => toOutput(candidate, config.agent)),
    ranked, proposed: proposals.length, verified, fit: null, context,
  };
}
