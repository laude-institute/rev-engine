// A naive baseline: one model call that sees the pull request and its diff and lists
// the problems. No tools, no project rules or design documents, no second look and
// no verification. It exists to measure how much the full review adds over the model alone.
import type { Config } from "./config.ts";
import { normalizeCandidates, parseDiff, rank, toOutput } from "./findings.ts";
import type { Chat } from "./llm.ts";
import { UNTRUSTED, submitReview } from "./prompts.ts";
import { loadPullRequest, type ReviewOutcome } from "./review.ts";
import { Workspace } from "./tools.ts";

/** Diffs are cut here so one call always fits the model's context. */
const MAX_DIFF_CHARS = 400_000;

export const NAIVE_SYSTEM = `You are reviewing a pull request. Report the problems you find in it by calling submit_review.

${UNTRUSTED}`;

export async function naiveReview(config: Config, chat: Chat, log: (message: string) => void): Promise<ReviewOutcome> {
  const workspace = new Workspace(config.repoDir, config.diffPath, config.base);
  const [pr, diff] = await Promise.all([loadPullRequest(config), workspace.diff()]);
  const changed = parseDiff(diff);
  const shown = diff.length <= MAX_DIFF_CHARS ? diff : `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff cut here]`;
  const prompt = `Pull request ${pr.nwo}#${pr.number}: ${pr.title}\n\n<description>\n${pr.body}\n</description>\n\n<diff>\n${shown}\n</diff>`;

  const reply = await chat({
    model: config.models[0]!, messages: [{ role: "system", content: NAIVE_SYSTEM }, { role: "user", content: prompt }],
    tools: [submitReview], timeoutMs: config.budgetMs * 0.9, caller: `naive (${config.models[0]})`,
  });
  const call = reply.tool_calls?.find((item) => item.function.name === submitReview.function.name);
  if (!call) throw new Error("the model did not call submit_review");
  const submission = JSON.parse(call.function.arguments) as Record<string, unknown>;

  // Findings must still cite real lines, because the benchmark's contract requires it.
  const candidates = await normalizeCandidates(submission.findings, {
    seat: "naive", repoDir: config.repoDir, changed, headFile: (path) => workspace.headFile(path), log,
  });
  log(`naive (${config.models[0]}): ${candidates.length} finding(s)`);
  const ranked = rank(candidates, config.maxFindings);
  return { findings: ranked.map((candidate) => toOutput(candidate, config.agent)), ranked, proposed: candidates.length, verified: false, fit: null };
}
