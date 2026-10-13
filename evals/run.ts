// Runs the review on every eval case several times and reports how often each
// labeled finding came back. Nothing is posted anywhere.
//
//   node evals/run.ts <run-name> [--runs 3] [--case <id>]... [--model <id>] [--judge <id>] [--jobs 3] [--score-only]
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Finding } from "../action/comments.ts";
import { createChat, emptyUsage } from "../src/llm.ts";
import type { ToolDefinition } from "../src/tools.ts";
import { parseCase, renderReport, scoreCase, type EvalCase, type RunResult } from "./lib.ts";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE = "rev-engine-prime:eval";
const REVIEW_TIMEOUT_MS = 20 * 60_000;

interface Options {
  name: string;
  runs: number;
  cases: string[];
  model: string;
  judge: string;
  jobs: number;
  scoreOnly: boolean;
}

function parseArguments(argv: string[]): Options {
  const options: Options = { name: "", runs: 3, cases: [], model: "anthropic/claude-opus-5.5", judge: "anthropic/claude-sonnet-5", jobs: 3, scoreOnly: false };
  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at]!;
    const value = (): string => argv[++at] ?? "";
    if (flag === "--runs") options.runs = Number(value());
    else if (flag === "--case") options.cases.push(value());
    else if (flag === "--model") options.model = value();
    else if (flag === "--judge") options.judge = value();
    else if (flag === "--jobs") options.jobs = Number(value());
    else if (flag === "--score-only") options.scoreOnly = true;
    else if (!flag.startsWith("-") && !options.name) options.name = flag;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!/^[\w.-]+$/.test(options.name)) throw new Error("give the run a name made of letters, digits, dots and dashes");
  if (!Number.isInteger(options.runs) || options.runs < 1) throw new Error("--runs must be a whole number of at least 1");
  if (!Number.isInteger(options.jobs) || options.jobs < 1) throw new Error("--jobs must be a whole number of at least 1");
  return options;
}

/** Cases in git, and cases about private repositories in a folder git ignores. */
async function loadCases(only: string[]): Promise<EvalCase[]> {
  const cases: EvalCase[] = [];
  for (const folder of ["evals/cases", "evals/private"]) {
    const directory = join(root, folder);
    if (!existsSync(directory)) continue;
    for (const file of (await readdir(directory)).filter((name) => name.endsWith(".json")).sort()) {
      cases.push(parseCase(JSON.parse(await readFile(join(directory, file), "utf8")), `${folder}/${file}`));
    }
  }
  const missing = only.filter((id) => !cases.some((item) => item.id === id));
  if (missing.length) throw new Error(`no case named ${missing.join(", ")}`);
  return only.length ? cases.filter((item) => only.includes(item.id)) : cases;
}

async function apiKey(): Promise<string> {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const text = await readFile(join(root, ".env"), "utf8").catch(() => "");
  const key = /^OPENROUTER_API_KEY=(.+)$/m.exec(text)?.[1]?.trim().replace(/^["']|["']$/g, "");
  if (!key) throw new Error("set OPENROUTER_API_KEY, or put it in .env");
  return key;
}

const git = (directory: string, ...args: string[]) => exec("git", ["-C", directory, ...args], { maxBuffer: 256 * 1024 * 1024 });

/** A checkout of the case's head, with the base fetched, plus the diff and the pull request text. */
async function prepare(evalCase: EvalCase, directory: string): Promise<void> {
  const cache = join(root, "runs/.cache/evals", evalCase.repo.replace("/", "__"));
  const remote = `https://github.com/${evalCase.repo}`;
  if (!existsSync(cache)) {
    await mkdir(dirname(cache), { recursive: true });
    await exec("git", ["clone", "--quiet", remote, cache]);
  }
  const repo = join(directory, "repo");
  if (!existsSync(repo)) {
    await exec("git", ["clone", "--quiet", cache, repo]);
    await git(repo, "fetch", "--quiet", remote, evalCase.head, evalCase.base);
    await git(repo, "checkout", "--quiet", evalCase.head);
  }
  await mkdir(join(directory, "pr"), { recursive: true });
  const { stdout } = await git(repo, "diff", `${evalCase.base}...${evalCase.head}`);
  await writeFile(join(directory, "pr/diff.patch"), stdout);
  await writeFile(join(directory, "pr/pr.json"), JSON.stringify({ title: evalCase.title, body: evalCase.body }));
}

async function review(evalCase: EvalCase, directory: string, out: string, options: Options, key: string): Promise<void> {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const env = {
    RB_NWO: evalCase.repo, RB_PR_NUMBER: String(evalCase.pr), RB_BASE: evalCase.base, RB_HEAD: evalCase.head,
    RB_CONFIG_MODEL: options.model, RB_CONFIG_FIT: options.model, RB_DETAILS_OUT: "/work/out/details.json",
    RB_REPO: "/work/repo", RB_DIFF: "/work/pr/diff.patch", RB_PR_JSON: "/work/pr/pr.json", RB_OUT: "/work/out/findings.json", RB_ATTEMPT: "1",
  };
  const args = [
    "run", "--rm", "-v", `${join(directory, "repo")}:/work/repo:ro`, "-v", `${join(directory, "pr")}:/work/pr:ro`, "-v", `${out}:/work/out`,
    "-e", "OPENROUTER_API_KEY", ...Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]), IMAGE,
  ];
  const result = await exec("docker", args, { env: { ...process.env, OPENROUTER_API_KEY: key }, timeout: REVIEW_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 })
    .catch((error: { stderr?: string; message: string }) => ({ stderr: `${error.stderr ?? ""}\n${error.message}` }));
  await writeFile(join(out, "log.txt"), result.stderr ?? "");
}

const submitMatches: ToolDefinition = {
  type: "function",
  function: {
    name: "submit_matches",
    description: "Say which reported findings, if any, match each expected finding.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["matches"],
      properties: {
        matches: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "findings", "reason"],
            properties: {
              id: { type: "string", description: "The id of the expected finding." },
              findings: { type: "array", items: { type: "integer" }, description: "The numbers of the reported findings that match. Empty when none does." },
              reason: { type: "string", description: "One sentence." },
            },
          },
        },
      },
    },
  },
};

const JUDGE_SYSTEM = `You compare two lists of code review findings about the same pull request. For each expected finding, decide whether one of the reported findings describes the same underlying problem. Two findings match when a developer who fixed one would have fixed the other. The same symptom with a different cause is not a match, and neither is a different problem in the same lines. Wording, severity and line numbers may differ. A review sometimes splits one problem into two findings; list every reported finding that describes the expected problem or a part of it. Answer for every expected id by calling submit_matches.`;

type Chat = ReturnType<typeof createChat>;

async function match(evalCase: EvalCase, findings: Finding[], chat: Chat, judge: string): Promise<Record<string, number[]>> {
  const expected = evalCase.findings.filter((item) => item.label !== "unlabeled");
  if (!expected.length || !findings.length) return Object.fromEntries(expected.map((item) => [item.id, []]));
  const prompt = [
    `Pull request ${evalCase.repo}#${evalCase.pr}: ${evalCase.title}`,
    `Expected findings:\n${JSON.stringify(expected.map(({ id, what, file }) => ({ id, file, what })), null, 2)}`,
    `Reported findings:\n${JSON.stringify(findings.map((finding, number) => ({ number, file: finding.file, lines: `${finding.start_line}-${finding.end_line}`, title: finding.title, detail: finding.detail })), null, 2)}`,
  ].join("\n\n");
  const answer = await chat({
    model: judge, tools: [submitMatches], forceTool: "submit_matches", timeoutMs: 120_000, caller: "judge",
    messages: [{ role: "system", content: JUDGE_SYSTEM }, { role: "user", content: prompt }],
  });
  const submitted = JSON.parse(answer.tool_calls?.[0]?.function.arguments ?? "{}") as { matches?: unknown };
  // Some models hand the list in as a JSON string inside the arguments.
  let list = typeof submitted.matches === "string" ? JSON.parse(submitted.matches) as unknown : submitted.matches;
  if (list && typeof list === "object" && !Array.isArray(list)) list = (list as { matches?: unknown }).matches;
  if (!Array.isArray(list)) throw new Error(`the matching model answered without a list: ${JSON.stringify(submitted).slice(0, 200)}`);
  const entries = list as Array<{ id: string; findings?: unknown }>;
  return Object.fromEntries(expected.map((item) => {
    const indexes = entries.find((entry) => entry.id === item.id)?.findings;
    return [item.id, (Array.isArray(indexes) ? indexes : []).filter((index): index is number => Number.isInteger(index) && Boolean(findings[index as number]))];
  }));
}

async function readRun(evalCase: EvalCase, out: string, chat: Chat, judge: string): Promise<RunResult> {
  const empty: RunResult = { findings: [], fit: null, costUsd: 0, seconds: 0, matches: {} };
  try {
    const output = JSON.parse(await readFile(join(out, "findings.json"), "utf8")) as { usage?: { cost_usd?: number; time_in_ms?: number } };
    const details = JSON.parse(await readFile(join(out, "details.json"), "utf8")) as { findings: Finding[] };
    const fit = await readFile(join(out, "fit.json"), "utf8").then((text) => (JSON.parse(text) as { verdict: string }).verdict, () => null);
    const run = { ...empty, findings: details.findings, fit, costUsd: output.usage?.cost_usd ?? 0, seconds: Math.round((output.usage?.time_in_ms ?? 0) / 1000) };
    return { ...run, matches: await match(evalCase, details.findings, chat, judge) };
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Runs the jobs a few at a time. */
async function pool(jobs: Array<() => Promise<void>>, width: number): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => {
    while (next < jobs.length) await jobs[next++]!();
  }));
}

const options = parseArguments(process.argv.slice(2));
const cases = await loadCases(options.cases);
if (!cases.length) throw new Error("no eval cases found in evals/cases or evals/private");
const key = await apiKey();
const runRoot = join(root, "runs/evals", options.name);
const say = (message: string): void => console.error(`eval: ${message}`);

if (!options.scoreOnly) {
  say("building the image");
  await exec("docker", ["build", "--quiet", "--tag", IMAGE, root]);
  for (const evalCase of cases) await prepare(evalCase, join(runRoot, evalCase.id));
  const jobs = cases.flatMap((evalCase) => Array.from({ length: options.runs }, (_, index) => async () => {
    say(`reviewing ${evalCase.id}, run ${index + 1}`);
    await review(evalCase, join(runRoot, evalCase.id), join(runRoot, evalCase.id, `run-${index + 1}`), options, key);
  }));
  await pool(jobs, options.jobs);
}

const judgeUsage = emptyUsage();
const chat = createChat({ apiKey: key, baseUrl: "https://openrouter.ai/api/v1", effort: null, usage: judgeUsage });
const scores = [];
const raw: Record<string, RunResult[]> = {};
for (const evalCase of cases) {
  const directory = join(runRoot, evalCase.id);
  const runs = existsSync(directory) ? (await readdir(directory)).filter((name) => /^run-\d+$/.test(name)).sort() : [];
  const results = await Promise.all(runs.map((run) => readRun(evalCase, join(directory, run), chat, options.judge)));
  for (const [index, result] of results.entries()) if (result.error) say(`${evalCase.id} ${runs[index]} left out: ${result.error}`);
  raw[evalCase.id] = results;
  scores.push(scoreCase(evalCase, results));
}

const settings = `Reviewer ${options.model}, matching by ${options.judge}, up to ${options.runs} run(s) per case.`;
const report = renderReport(options.name, settings, scores, judgeUsage.costUsd);
await writeFile(join(runRoot, "report.md"), report);
await writeFile(join(runRoot, "results.json"), `${JSON.stringify(raw, null, 2)}\n`);
console.log(report);
say(`report written to runs/evals/${options.name}/report.md`);
