// One review from start to finish: independent review seats, a verification
// pass over what they found, then a deterministic reduction to the final list.
import { readFile } from "node:fs/promises";
import { runAgent, type SecondLook } from "./agent.ts";
import type { Config } from "./config.ts";
import { pickDesignDocs } from "./docs.ts";
import { assessFit, type FitAssessment } from "./fit.ts";
import {
  applyVerdicts,
  atLeast,
  dedupe,
  normalizeCandidates,
  parseDiff,
  parseVerdicts,
  rank,
  toOutput,
  type Candidate,
  type OutputFinding,
} from "./findings.ts";
import type { Chat } from "./llm.ts";
import {
  reviewerSystem,
  SECOND_LOOK,
  followUpSection,
  VERIFIER_SYSTEM,
  reviewerPrompt,
  submitReview,
  submitVerdicts,
  verifierPrompt,
  type ProjectRule,
  type PullRequestInfo,
} from "./prompts.ts";
import { Workspace } from "./tools.ts";

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
const GENERATED = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|composer\.lock|Gemfile\.lock)$|\.(min\.js|map|snap|lock)$/;

function fileList(files: string[]): string {
  const listed = files.slice(0, MAX_FILES_LISTED).map((file) => `- ${file}`).join("\n");
  return files.length > MAX_FILES_LISTED ? `${listed}\n- and ${files.length - MAX_FILES_LISTED} more` : listed;
}

/**
 * Asks the reviewer to look again, naming the changed files it never opened.
 * The first pass's findings are kept beside the second pass's; the reduction step merges repeats.
 */
function secondLookFor(workspace: Workspace, changedFiles: string[]): SecondLook {
  return {
    message: () => {
      const unopened = changedFiles.filter((file) => !workspace.opened.has(file) && !GENERATED.test(file));
      if (!unopened.length) return SECOND_LOOK;
      return `${SECOND_LOOK}\n\nChanged files you have not opened yet. The diff shows only the changed lines, so open the ones that hold code, tests or configuration:\n${fileList(unopened)}`;
    },
    combine: (first, second) => ({
      findings: [...(Array.isArray(second.findings) ? second.findings : []), ...(Array.isArray(first.findings) ? first.findings : [])],
    }),
  };
}

export interface ReviewOutcome {
  findings: OutputFinding[];
  proposed: number;
  verified: boolean;
  /** The final findings before they were flattened for the findings file, in the same order. */
  ranked: Candidate[];
  /** Whether the change belongs in the project, when that was asked for and answered. */
  fit: FitAssessment | null;
}

async function loadPullRequest(config: Config): Promise<PullRequestInfo> {
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

async function loadRules(workspace: Workspace): Promise<ProjectRule[]> {
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
  const [pr, diff, rules] = await Promise.all([loadPullRequest(config), workspace.diff(), loadRules(workspace)]);
  const changed = parseDiff(diff);
  const documents = pickDesignDocs(await workspace.allFiles(MAX_INDEXED_FILES), [...changed.keys()], rules.map((rule) => rule.path));
  log(`diff has ${diff.split("\n").length} lines across ${changed.size} file(s); ${rules.length} project rule file(s) at base, ${documents.length} design document(s) offered`);

  const budget = { turns: config.maxTurns, minutes: Math.max(1, Math.round((reviewDeadline - Date.now()) / 60_000)) };
  const prompt = reviewerPrompt(pr, changed, diff, rules, documents, budget);
  const seats = await Promise.allSettled(config.models.map(async (model, index) => {
    const seat = `s${index + 1}`;
    const focus = config.focuses[index] ?? null;
    // Each seat gets its own workspace, so what one model has opened is tracked apart from the others.
    const seatWorkspace = new Workspace(config.repoDir, config.diffPath, config.base);
    const submission = await runAgent({
      chat, model, system: reviewerSystem(focus), prompt, workspace: seatWorkspace, submit: submitReview,
      deadline: reviewDeadline, maxTurns: config.maxTurns, log, caller: `${seat} (${model}${focus ? `@${focus}` : ""})`,
      ...(config.secondLook ? { secondLook: secondLookFor(seatWorkspace, [...changed.keys()]) } : {}),
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

  if (config.followUpModel && reviewDeadline - Date.now() >= MIN_FOLLOW_UP_MS) {
    // A model asked to look again in the same conversation tends to resubmit at once.
    // A new conversation reads the change afresh, and is told what has been found.
    const model = config.followUpModel;
    const seat = `s${config.models.length + 1}`;
    try {
      const found = dedupe(proposals);
      const cited = new Set(found.map((candidate) => candidate.file));
      const quiet = [...changed.keys()].filter((file) => !cited.has(file) && !GENERATED.test(file)).slice(0, MAX_FILES_LISTED);
      const followUpBudget = { turns: config.maxTurns, minutes: Math.max(1, Math.round((reviewDeadline - Date.now()) / 60_000)) };
      const seatWorkspace = new Workspace(config.repoDir, config.diffPath, config.base);
      const submission = await runAgent({
        chat, model, system: reviewerSystem(null),
        prompt: reviewerPrompt(pr, changed, diff, rules, documents, followUpBudget, followUpSection(found, quiet)),
        workspace: seatWorkspace, submit: submitReview, deadline: reviewDeadline, maxTurns: config.maxTurns, log,
        caller: `follow-up (${model})`,
        ...(config.secondLook ? { secondLook: secondLookFor(seatWorkspace, [...changed.keys()]) } : {}),
      });
      const candidates = await normalizeCandidates(submission.findings, {
        seat, repoDir: config.repoDir, changed, headFile: (path) => workspace.headFile(path), log,
      });
      log(`follow-up (${model}): ${candidates.length} finding(s)`);
      proposals.push(...candidates);
    } catch (error) {
      log(`follow-up (${model}) failed, keeping the findings so far: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (config.followUpModel) {
    log("follow-up skipped: too little review time is left");
  }

  let survivors = dedupe(proposals);
  if (config.minSeverity !== "low") {
    const before = survivors.length;
    survivors = atLeast(survivors, config.minSeverity);
    log(`kept ${survivors.length} of ${before} finding(s) at ${config.minSeverity} severity or above`);
  }
  let verified = false;
  if (verifying && survivors.length && finishDeadline - Date.now() >= MIN_VERIFY_MS) {
    try {
      const submission = await runAgent({
        chat, model: config.verifierModel, system: VERIFIER_SYSTEM,
        prompt: verifierPrompt(pr, changed, diff, survivors), workspace, submit: submitVerdicts,
        deadline: finishDeadline, maxTurns: config.maxTurns, log, caller: `verifier (${config.verifierModel})`,
      });
      const before = survivors.length;
      survivors = applyVerdicts(survivors, parseVerdicts(submission.verdicts), config.verify === "strict");
      verified = true;
      log(`verification kept ${survivors.length} of ${before} finding(s)`);
    } catch (error) {
      // A failed check should not throw away a finished review.
      log(`verification failed, keeping unverified findings: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const ranked = rank(survivors, config.maxFindings);
  const findings = ranked.map((candidate) => toOutput(candidate, config.agent));

  // The fit assessment comes last, so it knows what the review found. It may use the
  // time the review left over, and it never touches the findings.
  let fit: FitAssessment | null = null;
  const fitDeadline = started + config.budgetMs;
  if (config.fitModel && fitDeadline - Date.now() >= MIN_FIT_MS) {
    fit = await assessFit({
      chat, model: config.fitModel, pr, changed, diff, rules, documents, findings: ranked, deadline: fitDeadline,
      maxTurns: config.maxTurns, log, workspace: new Workspace(config.repoDir, config.diffPath, config.base),
    });
  } else if (config.fitModel) {
    log("fit skipped: too little time is left");
  }
  return { findings, ranked, proposed: proposals.length, verified, fit };
}
