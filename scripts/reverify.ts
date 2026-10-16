// Runs only the verification pass again, on the findings a recorded run proposed.
//
//   node scripts/reverify.ts <recorded-run> <new-run> --model <id> [--jobs <n>]
//
// A run made with RB_TRANSCRIPT_OUT keeps the verifier's conversation, whose first
// message lists the proposed findings. This sends the same message to another verifier
// model, with today's verifier prompt and read tools over the run's own checkout, then
// applies the verdicts as a real run does. Two verifiers can then be compared on the
// same proposals, without the noise of a new review. Findings land in
// runs/<new-run>/findings, ready for scripts/score.sh.
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { runAgent } from "../src/agent.ts";
import { applyVerdicts, parseVerdicts, rank, toOutput, type Candidate } from "../src/findings.ts";
import { createChat, emptyUsage, type ChatMessage, type Usage } from "../src/llm.ts";
import { submitVerdicts, VERIFIER_SYSTEM } from "../src/prompts.ts";
import { Workspace } from "../src/tools.ts";

const run = promisify(execFile);
const here = resolve(import.meta.dirname, "..");
const MAX_FINDINGS = 40;
const BUDGET_MS = 600_000;

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] ?? null : null;
}

const [recorded, target] = process.argv.slice(2).filter((arg, index, all) => !arg.startsWith("--") && !all[index - 1]?.startsWith("--"));
const model = option("--model");
if (!recorded || !target || !model) {
  console.error("usage: node scripts/reverify.ts <recorded-run> <new-run> --model <id> [--jobs <n>]");
  process.exit(2);
}
const jobs = Number(option("--jobs") ?? "5");

const env = await readFile(join(here, ".env"), "utf8").catch(() => "");
const apiKey = process.env.OPENROUTER_API_KEY || /^OPENROUTER_API_KEY=(.*)$/m.exec(env)?.[1]?.trim().replace(/^["']|["']$/g, "");
if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
const usage = emptyUsage();
const byCaller = new Map<string, Usage>();
const chat = createChat({ apiKey, baseUrl: "https://openrouter.ai/api/v1", effort: null, usage, usageByCaller: byCaller });

const runDir = join(here, "runs", recorded);
const outDir = join(runDir, ".try-agent", "out");
const findingsDir = join(here, "runs", target, "findings");
await mkdir(findingsDir, { recursive: true });

async function reverify(key: string): Promise<string> {
  const transcript = JSON.parse(await readFile(join(outDir, key, "transcript.json"), "utf8"));
  const verifier = transcript.conversations.find((item: { caller: string }) => item.caller.startsWith("verifier"));
  if (!verifier) return `${key}: no verification in the recording, skipped`;
  const prompt = String((verifier.messages as ChatMessage[]).find((message) => message.role === "user")?.content ?? "");
  const listed = /<findings>\n([\s\S]*)\n<\/findings>/.exec(prompt);
  if (!listed) return `${key}: no findings in the verifier prompt, skipped`;
  const candidates: Candidate[] = (JSON.parse(listed[1]!) as Array<Record<string, unknown>>).map((item) => ({
    id: String(item.id), seat: String(item.id).split("-")[0]!, file: String(item.file),
    startLine: Number(item.start_line), endLine: Number(item.end_line), severity: item.severity as Candidate["severity"],
    kind: "defect", title: String(item.title), detail: String(item.detail), confidence: 0.5,
  }));

  // The run's own checkout, which must still be at the reviewed head.
  const pr = JSON.parse(await readFile(join(runDir, ".try-agent", "pr", key, "pr.json"), "utf8"));
  const repo = join(runDir, ".try-agent", "repos", String(pr.nwo).replace("/", "_"));
  const head = (await run("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
  if (head !== pr.head) return `${key}: the checkout is at ${head.slice(0, 12)}, not the reviewed head, skipped`;
  const workspace = new Workspace(repo, join(runDir, ".try-agent", "pr", key, "diff.patch"), pr.base);

  const started = Date.now();
  const submission = await runAgent({
    chat, model: model!, system: VERIFIER_SYSTEM, prompt, workspace, submit: submitVerdicts,
    deadline: started + BUDGET_MS, maxTurns: 40, log: () => {}, caller: key,
  });
  const verdicts = parseVerdicts(submission.verdicts);
  const kept = rank(applyVerdicts(candidates, verdicts, false), MAX_FINDINGS);
  const recordedFindings = JSON.parse(await readFile(join(runDir, "findings", `${key}.json`), "utf8"));
  const spent = byCaller.get(key) ?? emptyUsage();
  await writeFile(join(findingsDir, `${key}.json`), `${JSON.stringify({
    pr: recordedFindings.pr, agent: "reverify", findings: kept.map((candidate) => toOutput(candidate, "reverify")),
    usage: {
      prompt_tokens: spent.promptTokens, completion_tokens: spent.completionTokens, total_tokens: spent.promptTokens + spent.completionTokens,
      cached_tokens: spent.cachedTokens, time_in_ms: Date.now() - started, cost_usd: Number(spent.costUsd.toFixed(6)),
    },
  }, null, 2)}\n`);
  const count = (name: string) => verdicts.filter((verdict) => verdict.verdict === name).length;
  const repeats = verdicts.filter((verdict) => verdict.duplicateOf && verdict.verdict !== "rejected").length;
  return `${key}: ${candidates.length} proposed, ${kept.length} kept; ${count("confirmed")} confirmed, ${count("rejected")} rejected, ${count("uncertain")} uncertain, ${repeats} repeats`;
}

const keys = (await readdir(outDir)).sort();
let next = 0;
await Promise.all(Array.from({ length: Math.min(jobs, keys.length) }, async () => {
  while (next < keys.length) {
    const key = keys[next++]!;
    try {
      console.error(await reverify(key));
    } catch (error) {
      console.error(`${key}: failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}));
console.error(`${usage.calls} model call(s), $${usage.costUsd.toFixed(2)}`);
