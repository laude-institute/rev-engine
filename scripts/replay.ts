// Replays the reporting step of a recorded run with a different reviewer prompt.
//
//   node scripts/replay.ts <recorded-run> <new-run> [--prompts <file>] [--model <id>] [--samples <n>] [--jobs <n>]
//
// A run made with RB_TRANSCRIPT_OUT keeps each reviewer's conversation. For every pull
// request, this takes the first seat's conversation up to its first submission, swaps
// in the system prompt and submit tool from --prompts (src/prompts.ts by default), and
// asks the model to submit. The code the reviewer read is reused as it was, so a variant
// costs one model call per pull request instead of a whole review. There is no second
// look and no verification, so scores are comparable only between replays.
//
// It measures how the prompt changes what the model reports, not what it reads. Confirm
// a change with a full run before keeping it. Findings land in runs/<new-run>[-<n>]/findings,
// ready for scripts/score.sh.
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { dedupe, normalizeCandidates, parseDiff, rank, toOutput, type Candidate } from "../src/findings.ts";
import { createChat, emptyUsage, type ChatMessage, type Usage } from "../src/llm.ts";
import type { ToolDefinition } from "../src/tools.ts";
import { readTools } from "../src/tools.ts";

const run = promisify(execFile);
const here = resolve(import.meta.dirname, "..");
const CONTAINER_REPO = "/work/repo";
const MAX_FINDINGS = 25;
const SUBMIT_NOW = "Stop investigating. Call submit_review now with what you have established so far.";
const TIMEOUT_MS = 300_000;

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

const [recorded, target] = process.argv.slice(2).filter((arg, index, all) => !arg.startsWith("--") && !all[index - 1]?.startsWith("--"));
if (!recorded || !target) {
  console.error("usage: node scripts/replay.ts <recorded-run> <new-run> [--prompts <file>] [--model <id>] [--samples <n>] [--jobs <n>]");
  process.exit(2);
}
const promptsPath = resolve(option("--prompts", join(here, "src/prompts.ts")));
const samples = Number(option("--samples", "1"));
const jobs = Number(option("--jobs", "8"));
const modelOverride = option("--model", "");

const variant = await import(pathToFileURL(promptsPath).href) as { reviewerSystem: (focus: string | null) => string; submitReview: ToolDefinition };
const system = variant.reviewerSystem(null);

// The key lives in .env or the shell, as for scripts/local-run.sh.
const env = await readFile(join(here, ".env"), "utf8").catch(() => "");
const apiKey = process.env.OPENROUTER_API_KEY || /^OPENROUTER_API_KEY=(.*)$/m.exec(env)?.[1]?.trim().replace(/^["']|["']$/g, "");
if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
const usage = emptyUsage();
const byCaller = new Map<string, Usage>();
const chat = createChat({ apiKey, baseUrl: "https://openrouter.ai/api/v1", effort: null, usage, usageByCaller: byCaller });

const runDir = join(here, "runs", recorded);
const outDir = join(runDir, ".try-agent", "out");
const keys = (await readdir(outDir)).sort();

/** The first seat's conversation up to, but not including, its first submission. */
function investigation(transcript: { conversations: Array<{ caller: string; model: string; messages: ChatMessage[] }> }) {
  const seat = transcript.conversations.find((conversation) => conversation.caller.startsWith("s1 "));
  if (!seat) return null;
  const cut = seat.messages.findIndex((message) => message.role === "assistant" && message.tool_calls?.some((call) => call.function.name === "submit_review"));
  if (cut < 0) return null;
  return { model: seat.model, messages: seat.messages.slice(1, cut) };
}

async function replayOne(key: string, sample: number): Promise<string> {
  const transcript = JSON.parse(await readFile(join(outDir, key, "transcript.json"), "utf8"));
  const recordedFindings = JSON.parse(await readFile(join(runDir, "findings", `${key}.json`), "utf8"));
  const found = investigation(transcript);
  if (!found) return `${key}: no first submission in the transcript, skipped`;
  const model = modelOverride || found.model;
  const messages: ChatMessage[] = [{ role: "system", content: system }, ...found.messages, { role: "user", content: SUBMIT_NOW }];

  const caller = `${key} ${sample}`;
  const started = Date.now();
  let submission: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < 3 && !submission; attempt += 1) {
    const reply = await chat({ model, messages, tools: [...readTools, variant.submitReview], timeoutMs: TIMEOUT_MS, caller });
    const call = reply.tool_calls?.find((item) => item.function.name === "submit_review");
    if (call) {
      try { submission = JSON.parse(call.function.arguments); } catch { /* asked again below */ }
    }
    if (submission) break;
    messages.push(reply);
    for (const other of reply.tool_calls ?? []) messages.push({ role: "tool", tool_call_id: other.id, content: "The investigation is over; no more tools can run." });
    messages.push({ role: "user", content: SUBMIT_NOW });
  }
  if (!submission) return `${key}: the model did not submit, skipped`;

  // The same path and line checks as a real run, against the recorded checkout at head.
  const diff = await readFile(join(runDir, ".try-agent", "pr", key, "diff.patch"), "utf8");
  const repo = join(here, "runs", ".cache", "repos", key.replace(/_[0-9]+-[0-9a-f]+$/, ""));
  const head = transcript.head as string;
  const headFile = async (path: string): Promise<string | null> => {
    try { return (await run("git", ["-C", repo, "show", `${head}:${path}`], { maxBuffer: 64 * 1024 * 1024 })).stdout; } catch { return null; }
  };
  const candidates: Candidate[] = await normalizeCandidates(submission.findings, {
    seat: "s1", repoDir: CONTAINER_REPO, changed: parseDiff(diff), headFile, log: () => {},
  });
  const ranked = rank(dedupe(candidates), MAX_FINDINGS);
  const dir = join(here, "runs", samples > 1 ? `${target}-${sample}` : target!, "findings");
  await mkdir(dir, { recursive: true });
  const spent = byCaller.get(caller) ?? emptyUsage();
  const output = {
    pr: recordedFindings.pr, agent: "replay", findings: ranked.map((candidate) => toOutput(candidate, "replay")),
    usage: {
      prompt_tokens: spent.promptTokens, completion_tokens: spent.completionTokens, total_tokens: spent.promptTokens + spent.completionTokens,
      cached_tokens: spent.cachedTokens, time_in_ms: Date.now() - started, cost_usd: Number(spent.costUsd.toFixed(6)),
    },
  };
  await writeFile(join(dir, `${key}.json`), `${JSON.stringify(output, null, 2)}\n`);
  return `${key}: ${ranked.length} finding(s)`;
}

// The samples of one pull request run one after another, so the later ones read the
// conversation from the provider's prompt cache instead of paying for it again.
const tasks = keys.map((key) => async () => {
  const lines: string[] = [];
  for (let sample = 1; sample <= samples; sample += 1) lines.push(await replayOne(key, sample));
  return lines.join("\n");
});
let next = 0;
await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, async () => {
  while (next < tasks.length) {
    const task = tasks[next++]!;
    try {
      console.error(await task());
    } catch (error) {
      console.error(`failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}));
console.error(`${usage.calls} model call(s), ${usage.promptTokens} prompt token(s) (${usage.cachedTokens} cached), $${usage.costUsd.toFixed(2)}`);
