// One review from start to finish: independent review seats, a verification
// pass over what they found, then a deterministic reduction to the final list.
import { readFile } from "node:fs/promises";
import { runAgent } from "./agent.ts";
import type { Config } from "./config.ts";
import {
  applyVerdicts,
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
  REVIEWER_SYSTEM,
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

export interface ReviewOutcome {
  findings: OutputFinding[];
  proposed: number;
  verified: boolean;
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
  log(`diff has ${diff.split("\n").length} lines across ${changed.size} file(s); ${rules.length} project rule file(s) at base`);

  const prompt = reviewerPrompt(pr, changed, diff, rules);
  const seats = await Promise.allSettled(config.models.map(async (model, index) => {
    const seat = `s${index + 1}`;
    const submission = await runAgent({
      chat, model, system: REVIEWER_SYSTEM, prompt, workspace, submit: submitReview,
      deadline: reviewDeadline, maxTurns: config.maxTurns, log,
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

  let survivors = dedupe(proposals);
  let verified = false;
  if (verifying && survivors.length && finishDeadline - Date.now() >= MIN_VERIFY_MS) {
    try {
      const submission = await runAgent({
        chat, model: config.verifierModel, system: VERIFIER_SYSTEM,
        prompt: verifierPrompt(pr, changed, diff, survivors), workspace, submit: submitVerdicts,
        deadline: finishDeadline, maxTurns: config.maxTurns, log,
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

  const findings = rank(survivors, config.maxFindings).map((candidate) => toOutput(candidate, config.agent));
  return { findings, proposed: proposals.length, verified };
}
