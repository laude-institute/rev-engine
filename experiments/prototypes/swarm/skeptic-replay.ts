// Runs the skeptic over a recorded swarm run's findings and saves its labels, so a filter
// on the labels can be scored from the run's saved matchings without reviewing again.
//
//   node experiments/prototypes/swarm/skeptic-replay.ts <run> [--matched <scoring-name>...]
//     [--providers a,b] [--reasoning <tokens>] [--model <model>]
//
// --matched checks only findings that some listed matching paired with an expected finding.
// Grounded scores depend only on those, so the rest need no label to measure a filter.
// Labels land in runs/<run>/skeptic.json, by pull request and the finding's rank.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createChat, emptyUsage, type Chat } from "../../../src/llm.ts";
import { Workspace } from "../../../src/tools.ts";
import { checkFindings, type SkepticCheck, type SkepticFinding } from "./skeptic.ts";

const [name, ...flags] = process.argv.slice(2);
if (!name) {
  console.error("usage: node experiments/prototypes/swarm/skeptic-replay.ts <run> [--matched <scoring-name>...] [--providers a,b] [--reasoning <tokens>] [--model <model>]");
  process.exit(2);
}
const option = (flag: string): string | null => {
  const at = flags.indexOf(flag);
  return at === -1 ? null : flags[at + 1] ?? null;
};
const matched: string[] = [];
for (let at = flags.indexOf("--matched") + 1; at > 0 && at < flags.length && !flags[at]!.startsWith("--"); at += 1) matched.push(flags[at]!);
const providers = option("--providers")?.split(",").filter(Boolean) ?? [];
const reasoningTokens = Number(option("--reasoning") ?? 1500);
const model = option("--model") ?? "deepseek/deepseek-v4.1-flash-1017";
const BATCH = 6;
const CONCURRENCY = 32;
const SECONDS = 300;

const env = await readFile(".env", "utf8").catch(() => "");
const apiKey = process.env.OPENROUTER_API_KEY ?? env.match(/^OPENROUTER_API_KEY=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
const usage = emptyUsage();
const base = createChat({ apiKey, baseUrl: "https://openrouter.ai/api/v1", effort: null, usage });
const chat: Chat = (request) => base({ ...request, reasoningTokens, ...(providers.length ? { providers } : {}) });

let running = 0;
const waiting: Array<() => void> = [];
const pool = async <T>(job: () => Promise<T>): Promise<T> => {
  if (running >= CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
  try { return await job(); } finally { running -= 1; waiting.shift()?.(); }
};

const runDir = join("runs", name);
const tryAgent = join(runDir, ".try-agent");
const labels: Record<string, Record<number, SkepticCheck>> = {};
const jobs: Array<Promise<void>> = [];
let count = 0;
for (const key of (await readdir(join(tryAgent, "out"))).sort()) {
  const trace = JSON.parse(await readFile(join(tryAgent, "out", key, "swarm.json"), "utf8")) as { final: Array<{ file: string; startLine: number; endLine: number; severity: string; kind: string }> };
  const messages = (JSON.parse(await readFile(join(runDir, "findings", `${key}.json`), "utf8")) as { findings: Array<{ message: string }> }).findings.map((finding) => finding.message);
  const pr = JSON.parse(await readFile(join(tryAgent, "pr", key, "pr.json"), "utf8")) as { nwo: string; pr_number: string; base: string; title?: string; body?: string };
  let wanted = trace.final.map((_, index) => index);
  if (matched.length) {
    const covered = new Set<number>();
    for (const scoring of matched) {
      const details = JSON.parse(await readFile(join(runDir, scoring, "results.details.json"), "utf8")) as Array<{ pr_key: string; candidate_findings: Array<{ covered_golden_indices: number[] }> }>;
      details.find((entry) => entry.pr_key === key)?.candidate_findings.forEach((finding, index) => { if (finding.covered_golden_indices.length) covered.add(index); });
    }
    wanted = wanted.filter((index) => covered.has(index));
  }
  // The label that agent mode puts at the start of a message is not part of the claim.
  const findings: SkepticFinding[] = wanted.map((index) => ({
    id: `f${index + 1}`, file: trace.final[index]!.file, startLine: trace.final[index]!.startLine, endLine: trace.final[index]!.endLine,
    severity: trace.final[index]!.severity, kind: trace.final[index]!.kind, message: messages[index]!.replace(/^\[[^\]]*\] /, ""),
  }));
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine);
  count += findings.length;
  labels[key] = {};
  const repoDir = resolve(tryAgent, "repos", pr.nwo.replace("/", "_"));
  const info = { nwo: pr.nwo, number: Number(pr.pr_number), title: pr.title ?? "", body: pr.body ?? "" };
  for (let start = 0; start < findings.length; start += BATCH) {
    const batch = findings.slice(start, start + BATCH);
    const caller = `skeptic/${key.slice(0, 20)}/b${start / BATCH + 1}`;
    jobs.push(pool(async () => {
      const checks = await checkFindings({
        chat, model, pr: info, findings: batch, workspace: new Workspace(repoDir, resolve(tryAgent, "pr", key, "diff.patch"), pr.base),
        deadline: Date.now() + SECONDS * 1000, maxTurns: 10, caller, log: () => {},
      });
      for (const finding of batch) labels[key]![Number(finding.id.slice(1)) - 1] = checks.get(finding.id)!;
      console.log(`  ${caller}: ${batch.map((finding) => checks.get(finding.id)!.label).join(", ")}`);
    }));
  }
}
console.log(`checking ${count} finding(s)`);
await Promise.all(jobs);
await writeFile(join(runDir, "skeptic.json"), `${JSON.stringify(labels, null, 2)}\n`);
const tally = new Map<string, number>();
for (const byIndex of Object.values(labels)) for (const check of Object.values(byIndex)) tally.set(check.label, (tally.get(check.label) ?? 0) + 1);
console.log(`labels: ${[...tally].map(([label, value]) => `${label} ${value}`).join(", ")}`);
console.log(`${usage.calls} model call(s), $${usage.costUsd.toFixed(4)}`);
