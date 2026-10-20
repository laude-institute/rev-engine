// One review from start to finish: independent review seats, a verification
// pass over what they found, then a deterministic reduction to the final list.
import { readFile } from "node:fs/promises";
import { runAgent, type SecondLook } from "./agent.ts";
import type { Config, SecondLookMode } from "./config.ts";
import { pickDesignDocs } from "./docs.ts";
import { assessFit, type FitAssessment } from "./fit.ts";
import {
  applyVerdicts,
  type ChangedLines,
  atLeast,
  dedupe,
  normalizeCandidates,
  parseDiff,
  parseVerdicts,
  rank,
  repeatsDecided,
  toOutput,
  type Candidate,
  type OutputFinding,
} from "./findings.ts";
import type { Chat } from "./llm.ts";
import {
  diffInPrompt,
  reviewerSystem,
  SECOND_LOOK,
  SMALL_PROBLEMS,
  sweepMessage,
  followUpSection,
  VERIFIER_SYSTEM,
  reviewerPrompt,
  submitReview,
  submitVerdicts,
  submitVerdictsWithPrior,
  verifierPrompt,
  type ProjectRule,
  type PullRequestInfo,
} from "./prompts.ts";
import { loadPrior, repeatNote } from "./prior.ts";
import { Workspace, type ReadRecord } from "./tools.ts";

/** Instruction files read from the base revision, so the change cannot rewrite the rules it is judged by. */
const RULE_FILES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", ".github/copilot-instructions.md", ".cursorrules"];
const MAX_RULE_CHARS = 6_000;
const MAX_RULES_TOTAL_CHARS = 16_000;

/** Share of the time budget the review seats may use; verification gets the rest. */
const REVIEW_SHARE = 0.6;
const FINISH_SHARE = 0.92;
const MIN_VERIFY_MS = 60_000;
/** A follow-up review that starts with less time than this would only skim. */
const MIN_FOLLOW_UP_MS = 150_000;
/** The fit assessment needs time to read the project's documents and to write its answer. */
const MIN_FIT_MS = 150_000;
const MAX_INDEXED_FILES = 20_000;

const MAX_FILES_LISTED = 25;

/** Lock files and generated output are rarely worth a reviewer's turn. */
export const GENERATED = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|composer\.lock|Gemfile\.lock)$|\.(min\.js|map|snap|lock)$/;

function fileList(files: string[]): string {
  const listed = files.slice(0, MAX_FILES_LISTED).map((file) => `- ${file}`).join("\n");
  return files.length > MAX_FILES_LISTED ? `${listed}\n- and ${files.length - MAX_FILES_LISTED} more` : listed;
}

/** Logs each finding a step removed, so a run's log shows where a finding was lost. */
function logDropped(step: string, before: Candidate[], after: Candidate[], log: (message: string) => void, why: (candidate: Candidate) => string): void {
  const kept = new Set(after.map((candidate) => candidate.id));
  for (const candidate of before) {
    if (kept.has(candidate.id)) continue;
    log(`${step} dropped ${candidate.id} (${why(candidate)}): ${candidate.file}:${candidate.startLine} ${candidate.title.slice(0, 120)}`);
  }
}

/**
 * Asks the reviewer to look again, naming the changed files it never opened.
 * The first pass's findings are kept beside the second pass's; the reduction step merges repeats.
 */
function secondLookFor(workspace: Workspace, changedFiles: string[], smallProblems = false): SecondLook {
  return {
    message: (round) => {
      if (round === 2 && smallProblems) return SMALL_PROBLEMS;
      if (round > 1) return null;
      const unopened = changedFiles.filter((file) => !workspace.opened.has(file) && !GENERATED.test(file));
      if (!unopened.length) return SECOND_LOOK;
      return `${SECOND_LOOK}\n\nChanged files you have not opened yet. The diff shows only the changed lines, so open the ones that hold code, tests or configuration:\n${fileList(unopened)}`;
    },
    combine: combineSubmissions,
  };
}

/** Later rounds come first, so when two rounds repeat a finding the merge keeps the more considered one. */
function combineSubmissions(submissions: Array<Record<string, unknown>>): Record<string, unknown> {
  return { findings: submissions.toReversed().flatMap((submission) => Array.isArray(submission.findings) ? submission.findings : []) };
}

/** Changed lines per sweep round; a file larger than this gets a round of its own. */
const SWEEP_ROUND_LINES = 150;
const MAX_SWEEP_ROUNDS = 6;
/** Added lines closer than this are one hunk to the reviewer. */
const HUNK_GAP = 6;

/**
 * Splits the changed lines of hand-written files into rounds, in diff order. Each
 * round lists files and their changed line ranges. A large change gets larger rounds
 * rather than more of them, so the sweep fits the time budget.
 */
export function sweepRounds(changed: ChangedLines): string[] {
  const files = [...changed].filter(([file, ranges]) => ranges.length && !GENERATED.test(file)).map(([file, ranges]) => {
    const hunks: Array<[number, number]> = [];
    for (const [start, end] of ranges) {
      const last = hunks.at(-1);
      if (last && start - last[1] <= HUNK_GAP) last[1] = Math.max(last[1], end);
      else hunks.push([start, end]);
    }
    return { file, hunks, size: ranges.reduce((sum, [start, end]) => sum + end - start + 1, 0) };
  });
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const target = Math.max(SWEEP_ROUND_LINES, Math.ceil(total / MAX_SWEEP_ROUNDS));
  const rounds: Array<typeof files> = [];
  let size = 0;
  for (const file of files) {
    if (!rounds.length || size + file.size > target) {
      rounds.push([]);
      size = 0;
    }
    rounds.at(-1)!.push(file);
    size += file.size;
  }
  return rounds.map((round) => round.map(({ file, hunks }) =>
    `- ${file}: ${hunks.map(([start, end]) => start === end ? `line ${start}` : `lines ${start} to ${end}`).join(", ")}`).join("\n"));
}

function sweepFor(changed: ChangedLines, mode: SecondLookMode): SecondLook {
  const rounds = sweepRounds(changed);
  return {
    message: (round) => round <= rounds.length ? sweepMessage(round, rounds.length, rounds[round - 1]!, mode === "sweep-low") : null,
    combine: combineSubmissions,
  };
}

function afterFirstSubmission(config: Config, workspace: Workspace, changed: ChangedLines): { secondLook?: SecondLook } {
  if (config.secondLook === "off") return {};
  if (config.secondLook === "on" || config.secondLook === "small") {
    return { secondLook: secondLookFor(workspace, [...changed.keys()], config.secondLook === "small") };
  }
  return { secondLook: sweepFor(changed, config.secondLook) };
}

export interface ReviewOutcome {
  findings: OutputFinding[];
  proposed: number;
  verified: boolean;
  /** The final findings before they were flattened for the findings file, in the same order. */
  ranked: Candidate[];
  /** Whether the change belongs in the project, when that was asked for and answered. */
  fit: FitAssessment | null;
  /** What each model read, so a run can show whether the review had enough context. */
  context: ReviewContext;
  /** Findings the verifier left out because they repeat an earlier finding the maintainer decided. */
  decided?: DecidedRepeat[];
}

export interface DecidedRepeat {
  file: string;
  title: string;
  /** The earlier finding's id in prior.json. */
  repeatOf: string;
}

export interface ReviewContext {
  /** Whether the whole diff was in the reviewer's prompt, rather than read through read_diff. */
  diffInPrompt: boolean;
  readers: Array<{ caller: string; reads: ReadRecord[] }>;
}

export async function loadPullRequest(config: Config): Promise<PullRequestInfo> {
  const info: PullRequestInfo = { nwo: config.nwo, number: config.prNumber, title: "", body: "" };
  try {
    const parsed = JSON.parse(await readFile(config.prJsonPath, "utf8")) as Record<string, unknown>;
    if (typeof parsed.title === "string") info.title = parsed.title;
    if (typeof parsed.body === "string") info.body = parsed.body;
  } catch {
    // The diff is enough to review; the title and description only add intent.
  }
  return info;
}

export async function loadRules(workspace: Workspace): Promise<ProjectRule[]> {
  const rules: ProjectRule[] = [];
  let total = 0;
  for (const path of RULE_FILES) {
    const text = (await workspace.baseFile(path))?.trim();
    if (!text || total >= MAX_RULES_TOTAL_CHARS) continue;
    const cut = text.slice(0, Math.min(MAX_RULE_CHARS, MAX_RULES_TOTAL_CHARS - total));
    total += cut.length;
    rules.push({ path, text: cut.length < text.length ? `${cut}\n[file cut here]` : cut });
  }
  return rules;
}

export async function review(config: Config, chat: Chat, log: (message: string) => void): Promise<ReviewOutcome> {
  const started = Date.now();
  const verifying = config.verify !== "off";
  const reviewDeadline = started + config.budgetMs * (verifying ? REVIEW_SHARE : FINISH_SHARE);
  const finishDeadline = started + config.budgetMs * FINISH_SHARE;

  const workspace = new Workspace(config.repoDir, config.diffPath, config.base);
  const [pr, diff, rules, prior] = await Promise.all([loadPullRequest(config), workspace.diff(), loadRules(workspace), loadPrior(config.priorJsonPath, log)]);
  // A file can hold fit answers and no decided findings; then the reviewer and verifier are not told about decisions.
  const decisions = prior?.entries.length ? prior : null;
  const changed = parseDiff(diff);
  const documents = pickDesignDocs(await workspace.allFiles(MAX_INDEXED_FILES), [...changed.keys()], rules.map((rule) => rule.path));
  log(`diff has ${diff.split("\n").length} lines across ${changed.size} file(s); ${rules.length} project rule file(s) at base, ${documents.length} design document(s) offered`);

  const budget = { turns: config.maxTurns, minutes: Math.max(1, Math.round((reviewDeadline - Date.now()) / 60_000)) };
  const prompt = reviewerPrompt(pr, changed, diff, rules, documents, budget, undefined, decisions);
  const context: ReviewContext = { diffInPrompt: diffInPrompt(diff), readers: [] };
  const track = (caller: string, tracked: Workspace): Workspace => {
    context.readers.push({ caller, reads: tracked.reads });
    return tracked;
  };
  const seats = await Promise.allSettled(config.models.map(async (model, index) => {
    const seat = `s${index + 1}`;
    const focus = config.focuses[index] ?? null;
    // Each seat gets its own workspace, so what one model has opened is tracked apart from the others.
    const caller = `${seat} (${model}${focus ? `@${focus}` : ""})`;
    const seatWorkspace = track(caller, new Workspace(config.repoDir, config.diffPath, config.base));
    const submission = await runAgent({
      chat, model, system: reviewerSystem(focus), prompt, workspace: seatWorkspace, submit: submitReview,
      deadline: reviewDeadline, maxTurns: config.maxTurns, log, caller,
      ...afterFirstSubmission(config, seatWorkspace, changed),
    });
    const candidates = await normalizeCandidates(submission.findings, {
      seat, repoDir: config.repoDir, changed, headFile: (path) => workspace.headFile(path), log,
    });
    log(`${seat} (${model}): ${candidates.length} finding(s)`);
    return candidates;
  }));

  const proposals: Candidate[] = [];
  let succeeded = 0;
  for (const [index, seat] of seats.entries()) {
    if (seat.status === "fulfilled") {
      succeeded += 1;
      proposals.push(...seat.value);
    } else {
      log(`s${index + 1} (${config.models[index]}) failed: ${seat.reason instanceof Error ? seat.reason.message : String(seat.reason)}`);
    }
  }
  // An empty list would claim the change is clean, so a run where no seat finished must fail instead.
  if (!succeeded) throw new Error("no review seat completed");

  /** One more review in a new conversation. It never throws: a failure keeps the findings so far. */
  const reviewAgain = async (model: string, caller: string, section?: string): Promise<void> => {
    const seat = `s${config.models.length + 1}`;
    try {
      const againBudget = { turns: config.maxTurns, minutes: Math.max(1, Math.round((reviewDeadline - Date.now()) / 60_000)) };
      const seatWorkspace = track(caller, new Workspace(config.repoDir, config.diffPath, config.base));
      const submission = await runAgent({
        chat, model, system: reviewerSystem(null),
        prompt: reviewerPrompt(pr, changed, diff, rules, documents, againBudget, section, decisions),
        workspace: seatWorkspace, submit: submitReview, deadline: reviewDeadline, maxTurns: config.maxTurns, log, caller,
        ...afterFirstSubmission(config, seatWorkspace, changed),
      });
      const candidates = await normalizeCandidates(submission.findings, {
        seat, repoDir: config.repoDir, changed, headFile: (path) => workspace.headFile(path), log,
      });
      log(`${caller}: ${candidates.length} finding(s)`);
      proposals.push(...candidates);
    } catch (error) {
      log(`${caller} failed, keeping the findings so far: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  if (!proposals.length && config.retryEmpty) {
    // An empty list claims the change is clean, so it needs two independent reviews that agree.
    // The retry is not told the first review was empty, so it is not pushed to find something.
    // It runs at most once, and whatever it returns is final.
    if (reviewDeadline - Date.now() >= MIN_FOLLOW_UP_MS) {
      await reviewAgain(config.models[0]!, `retry (${config.models[0]})`);
    } else {
      log("retry skipped: too little review time is left");
    }
  } else if (config.followUpModel && reviewDeadline - Date.now() >= MIN_FOLLOW_UP_MS) {
    // A model asked to look again in the same conversation tends to resubmit at once.
    // A new conversation reads the change afresh, and is told what has been found.
    const found = dedupe(proposals);
    const cited = new Set(found.map((candidate) => candidate.file));
    const quiet = [...changed.keys()].filter((file) => !cited.has(file) && !GENERATED.test(file)).slice(0, MAX_FILES_LISTED);
    await reviewAgain(config.followUpModel, `follow-up (${config.followUpModel})`, followUpSection(found, quiet));
  } else if (config.followUpModel) {
    log("follow-up skipped: too little review time is left");
  }

  let survivors = dedupe(proposals);
  logDropped("merge", proposals, survivors, log, () => "repeats a finding that was kept");
  if (config.minSeverity !== "low") {
    const before = survivors.length;
    survivors = atLeast(survivors, config.minSeverity);
    log(`kept ${survivors.length} of ${before} finding(s) at ${config.minSeverity} severity or above`);
  }
  let verified = false;
  const decided: DecidedRepeat[] = [];
  if (verifying && survivors.length && finishDeadline - Date.now() >= MIN_VERIFY_MS) {
    track(`verifier (${config.verifierModel})`, workspace);
    try {
      const submission = await runAgent({
        chat, model: config.verifierModel, system: VERIFIER_SYSTEM,
        prompt: verifierPrompt(pr, changed, diff, survivors, decisions), workspace, submit: decisions ? submitVerdictsWithPrior : submitVerdicts,
        deadline: finishDeadline, maxTurns: config.maxTurns, log, caller: `verifier (${config.verifierModel})`,
      });
      const before = survivors;
      const verdicts = new Map(parseVerdicts(submission.verdicts).map((verdict) => [verdict.id, verdict]));
      survivors = applyVerdicts(survivors, [...verdicts.values()], config.verify === "strict").map((candidate) => {
        // A repeat the verifier kept says which earlier finding it is, so the author can tell a regression from noise.
        const verdict = verdicts.get(candidate.id);
        const earlier = verdict?.repeatOf && verdict.exceptionHolds ? decisions?.entries.find((entry) => entry.id === verdict.repeatOf) : undefined;
        return earlier ? { ...candidate, detail: `${candidate.detail.trimEnd()} ${repeatNote(earlier)}` } : candidate;
      });
      verified = true;
      for (const candidate of before) {
        const verdict = verdicts.get(candidate.id);
        if (verdict?.verdict !== "rejected" && repeatsDecided(verdict)) decided.push({ file: candidate.file, title: candidate.title, repeatOf: verdict!.repeatOf! });
      }
      log(`verification kept ${survivors.length} of ${before.length} finding(s)`);
      logDropped("verification", before, survivors, log, (candidate) => {
        const verdict = verdicts.get(candidate.id);
        if (!verdict) return "no verdict";
        if (verdict.verdict !== "rejected" && repeatsDecided(verdict)) return `repeats earlier decided ${verdict.repeatOf}`;
        return verdict.duplicateOf && verdict.verdict !== "rejected" ? `repeats ${verdict.duplicateOf}` : verdict.verdict;
      });
    } catch (error) {
      // A failed check should not throw away a finished review.
      log(`verification failed, keeping unverified findings: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const ranked = rank(survivors, config.maxFindings);
  logDropped("cap", survivors, ranked, log, () => `beyond the cap of ${config.maxFindings}`);
  const findings = ranked.map((candidate) => toOutput(candidate, config.agent));

  // The fit assessment comes last, so it knows what the review found. It may use the
  // time the review left over, and it never touches the findings.
  let fit: FitAssessment | null = null;
  const fitDeadline = started + config.budgetMs;
  if (config.fitModel && fitDeadline - Date.now() >= MIN_FIT_MS) {
    fit = await assessFit({
      chat, model: config.fitModel, pr, changed, diff, rules, documents, findings: ranked, prior, deadline: fitDeadline,
      maxTurns: config.maxTurns, log, workspace: track(`fit (${config.fitModel})`, new Workspace(config.repoDir, config.diffPath, config.base)),
    });
  } else if (config.fitModel) {
    log("fit skipped: too little time is left");
  }
  return { findings, ranked, proposed: proposals.length, verified, fit, context, decided };
}
