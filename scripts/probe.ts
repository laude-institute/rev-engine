// Asks a recorded reviewer about the expected findings it missed, to learn why it missed them.
//
//   node scripts/probe.ts <run> [--keys <key,key>] [--levels opened,diff,file,none]
//
// For each missed finding that scripts/coverage.ts lists, this continues the first
// reviewer's recorded conversation after its final submission, points it at the
// finding's lines without saying what is wrong, and asks whether there is a problem
// and, if so, why the review left it out. A second model then decides whether the
// answer describes the expected finding. The question quotes the lines, so the reviewer
// knows which code is meant even when it saw them only in the diff. The probes of one
// pull request are asked in turn in one conversation, so each reads the ones before it
// from the prompt cache. Each miss lands in one of these groups:
//
//   found      pointed at the lines, the reviewer names the expected problem
//   other      it names a different problem in those lines
//   not found  it sees no problem there
//
// A miss it finds when pointed at was within reach: the reviewer had what it needed
// and did not notice or chose not to report. The reasons it gives are its own account,
// not a reliable explanation, but reasons that repeat point at the rule behind them.
//
// The probes point at the expected answers, so they are for diagnosis on the 25 pull
// request test set only. Nothing here goes into the prompts or the image. Results
// land in runs/<run>/probes.json and runs/<run>/probes.md.
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { createChat, emptyUsage, type ChatMessage, type Usage } from "../src/llm.ts";
import { readTools, type ToolDefinition } from "../src/tools.ts";

const here = resolve(import.meta.dirname, "..");
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "google/gemini-3.5-flash";
const TIMEOUT_MS = 300_000;
const MAX_QUOTED_LINES = 60;
const run = promisify(execFile);

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] ?? null : null;
}

const name = process.argv[2];
if (!name || name.startsWith("--")) {
  console.error("usage: node scripts/probe.ts <run> [--keys <key,key>] [--levels opened,diff,file,none]");
  process.exit(2);
}
const keys = option("--keys")?.split(",") ?? null;
const levels = (option("--levels") ?? "opened,diff,file,none").split(",");
const runDir = join(here, "runs", name);

const env = await readFile(join(here, ".env"), "utf8").catch(() => "");
const apiKey = process.env.OPENROUTER_API_KEY || /^OPENROUTER_API_KEY=(.*)$/m.exec(env)?.[1]?.trim().replace(/^["']|["']$/g, "");
if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
const usage = emptyUsage();
const byCaller = new Map<string, Usage>();
const chat = createChat({ apiKey, baseUrl: "https://openrouter.ai/api/v1", effort: null, usage, usageByCaller: byCaller });

const answerProbe: ToolDefinition = {
  type: "function",
  function: {
    name: "answer_probe",
    description: "Answer the question about the lines you were pointed at.",
    parameters: {
      type: "object", additionalProperties: false,
      required: ["problem_found", "problem", "during_review", "reason_left_out"],
      properties: {
        problem_found: { type: "boolean", description: "Whether those lines hold a problem a reviewer should raise on this pull request." },
        problem: { type: "string", description: "The problem, in one to three sentences. Empty when there is none." },
        during_review: {
          type: "string", enum: ["reported it", "noticed it but left it out", "did not notice it", "no problem"],
          description: "What happened to this problem in the review you submitted.",
        },
        reason_left_out: { type: "string", description: "When you noticed the problem but left it out, why. Empty otherwise." },
      },
    },
  },
};

const submitMatch: ToolDefinition = {
  type: "function",
  function: {
    name: "submit_match",
    description: "Say whether the answer describes the expected problem.",
    parameters: {
      type: "object", additionalProperties: false, required: ["same_problem"],
      properties: { same_problem: { type: "boolean", description: "True when the answer names the same underlying problem, even in other words or with less detail." } },
    },
  },
};

interface Miss { key: string; file: string; start: number; end: number; level: string; severity: string; message: string }

/** The missed findings from coverage.md, which scripts/coverage.ts writes. */
async function missedFindings(): Promise<Miss[]> {
  const text = await readFile(join(runDir, "coverage.md"), "utf8").catch(() => {
    throw new Error(`no coverage.md for ${name}; run node scripts/coverage.ts ${name} first`);
  });
  const golden = new Map<string, Array<{ file: string; start_line: number; end_line: number; message: string; tp_fp: string }>>();
  const misses: Miss[] = [];
  for (const line of text.split("\n")) {
    const match = /^\| (\S+) \| (.+?):(\d+)-(\d+) \| (\w+) \| (\w+) \|/.exec(line);
    if (!match || !levels.includes(match[5]!) || (keys && !keys.includes(match[1]!))) continue;
    const [, key, file, start, end, level, severity] = match as unknown as string[];
    // The table cuts messages short, so take the whole message from the golden file.
    if (!golden.has(key!)) {
      const bench = process.env.REVIEWBENCH_DIR ?? join(here, "..", "ReviewBench");
      golden.set(key!, JSON.parse(await readFile(join(bench, "golden", `${key}.json`), "utf8")).findings);
    }
    const expected = golden.get(key!)!.find((item) => item.tp_fp === "tp" && item.file === file && item.start_line === Number(start) && item.end_line === Number(end));
    if (expected) misses.push({ key: key!, file: file!, start: Number(start), end: Number(end), level: level!, severity: severity!, message: expected.message });
  }
  return misses;
}

/** The first reviewer's whole conversation, closed off after its final submission. */
async function conversation(key: string): Promise<{ model: string; messages: ChatMessage[]; head: string } | null> {
  const transcript = JSON.parse(await readFile(join(runDir, ".try-agent", "out", key, "transcript.json"), "utf8"));
  const seat = transcript.conversations.find((item: { caller: string }) => item.caller.startsWith("s1 "));
  if (!seat) return null;
  const messages: ChatMessage[] = [...seat.messages];
  const last = messages.at(-1);
  for (const call of (last?.role === "assistant" && last.tool_calls) || []) {
    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: true, message: "Review received." }) });
  }
  return { model: seat.model, messages, head: transcript.head };
}

/** The finding's lines at head, numbered, from the cached checkout that local runs share. */
async function quote(key: string, head: string, miss: Miss): Promise<string> {
  const repo = join(here, "runs", ".cache", "repos", key.replace(/_[0-9]+-[0-9a-f]+$/, ""));
  try {
    const { stdout } = await run("git", ["-C", repo, "show", `${head}:${miss.file}`], { maxBuffer: 64 * 1024 * 1024 });
    const lines = stdout.split("\n").slice(miss.start - 1, Math.min(miss.end, miss.start - 1 + MAX_QUOTED_LINES));
    const cut = miss.end - miss.start + 1 > MAX_QUOTED_LINES ? "\n[cut here]" : "";
    return `\n\n<lines>\n${lines.map((line, index) => `${miss.start + index}: ${line}`).join("\n")}${cut}\n</lines>`;
  } catch {
    return "";
  }
}

interface Answer { problem_found: boolean; problem: string; during_review: string; reason_left_out: string }

/** Asks about one miss at the end of the conversation, and leaves the exchange in it for the next probe. */
async function probe(miss: Miss, messages: ChatMessage[], model: string, head: string, first: boolean) {
  const opening = first ? "Your review is submitted. A few more questions follow, each about different lines. Answer each one on its own." : "Next question, about different lines.";
  const question = `${opening} Look at ${miss.file}, lines ${miss.start} to ${miss.end}, as the file is after the change.${await quote(miss.key, head, miss)}\n\nIs there a problem in those lines that a reviewer should raise on this pull request? Answer from what you have already read, with answer_probe. You cannot open more files now.`;
  messages.push({ role: "user", content: question });
  // Some models refuse a forced tool choice, so the answer tool is offered and asked for again if skipped.
  let answer: Answer | null = null;
  for (let attempt = 0; attempt < 3 && !answer; attempt += 1) {
    const reply = await chat({ model, messages, tools: [...readTools, answerProbe], timeoutMs: TIMEOUT_MS, caller: `probe ${miss.key}` });
    messages.push(reply);
    const call = reply.tool_calls?.find((item) => item.function.name === answerProbe.function.name);
    if (call) {
      try { answer = JSON.parse(call.function.arguments); } catch { /* asked again below */ }
    }
    if (answer) {
      for (const item of reply.tool_calls ?? []) messages.push({ role: "tool", tool_call_id: item.id, content: JSON.stringify({ ok: true }) });
      break;
    }
    for (const other of reply.tool_calls ?? []) messages.push({ role: "tool", tool_call_id: other.id, content: "No more files can be opened. Answer from what you have read." });
    messages.push({ role: "user", content: "Answer with answer_probe now, from what you have already read." });
  }
  let same = false;
  if (answer?.problem_found && answer.problem) {
    const verdict = await chat({
      model: JUDGE_MODEL, timeoutMs: TIMEOUT_MS, caller: "judge", tools: [submitMatch], forceTool: submitMatch.function.name,
      messages: [
        { role: "system", content: "You compare two descriptions of a problem in code review and say whether they describe the same underlying problem." },
        { role: "user", content: `Expected problem at ${miss.file}:${miss.start}-${miss.end}:\n${miss.message}\n\nThe reviewer's answer:\n${answer.problem}` },
      ],
    });
    const verdictCall = verdict.tool_calls?.find((item) => item.function.name === submitMatch.function.name);
    same = verdictCall ? Boolean(JSON.parse(verdictCall.function.arguments).same_problem) : false;
  }
  const outcome = !answer ? "no answer" : !answer.problem_found ? "not found" : same ? "found" : "other";
  return { ...miss, outcome, answer };
}

const misses = await missedFindings();
const byKey = new Map<string, Miss[]>();
for (const miss of misses) byKey.set(miss.key, [...byKey.get(miss.key) ?? [], miss]);
console.error(`${misses.length} missed finding(s) across ${byKey.size} pull request(s)`);
const results: Array<Awaited<ReturnType<typeof probe>>> = [];
// One pull request at a time and its probes in order, so later probes read the conversation from the prompt cache.
await Promise.all([...byKey].map(async ([key, group]) => {
  const base = await conversation(key);
  if (!base) { console.error(`${key}: no first reviewer in the transcript, skipped`); return; }
  for (const [index, miss] of group.entries()) {
    try {
      const result = await probe(miss, base.messages, base.model, base.head, index === 0);
      results.push(result);
      console.error(`${key} ${miss.file}:${miss.start}: ${result.outcome}`);
    } catch (error) {
      console.error(`${key} ${miss.file}:${miss.start}: failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}));

await writeFile(join(runDir, "probes.json"), `${JSON.stringify(results, null, 2)}\n`);
const cell = (text: string) => text.replace(/\s+/g, " ").replaceAll("|", "\\|");
const outcomes = ["found", "other", "not found", "no answer"];
const crossTable = (title: string, values: string[], group: (result: typeof results[number]) => string) => [
  `| ${title} | ${outcomes.join(" | ")} | All |`,
  `|---|${outcomes.map(() => "---|").join("")}---|`,
  ...values.map((value) => {
    const inGroup = results.filter((result) => group(result) === value);
    return `| ${value} | ${outcomes.map((outcome) => inGroup.filter((result) => result.outcome === outcome).length).join(" | ")} | ${inGroup.length} |`;
  }),
].join("\n");
const report = [
  `# Probes of missed findings in ${name}`,
  "",
  "How close the reviewers came, against the probe's outcome:",
  "",
  crossTable("Reviewers", ["opened", "diff", "file", "none"], (result) => result.level),
  "",
  crossTable("Severity", ["high", "medium", "low"], (result) => result.severity),
  "",
  "What the reviewer says happened during its review. Its own account, not a reliable explanation:",
  "",
  crossTable("During review", ["reported it", "noticed it but left it out", "did not notice it", "no problem", ""], (result) => result.answer?.during_review ?? ""),
  "",
  "| Pull request | Where | Severity | Outcome | During review | Expected | Answer | Reason left out |",
  "|---|---|---|---|---|---|---|---|",
  ...results.map((result) => `| ${result.key} | ${result.file}:${result.start}-${result.end} | ${result.severity} | ${result.outcome} | ${result.answer?.during_review ?? ""} | ${cell(result.message).slice(0, 200)} | ${cell(result.answer?.problem ?? "").slice(0, 200)} | ${cell(result.answer?.reason_left_out ?? "")} |`),
].join("\n");
await writeFile(join(runDir, "probes.md"), `${report}\n`);
const probeCost = [...byCaller].filter(([caller]) => caller.startsWith("probe")).reduce((sum, [, spent]) => sum + spent.costUsd, 0);
console.log(report.split("\n").slice(0, 28).join("\n"));
console.error(`${usage.calls} model call(s), ${usage.promptTokens} prompt token(s) (${usage.cachedTokens} cached), $${usage.costUsd.toFixed(2)} ($${probeCost.toFixed(2)} for probes)`);
