// Shows whether a run's reviewers read the code behind each expected finding.
//
//   node scripts/coverage.ts <run>
//
// For every true finding in the benchmark's golden file, it says whether the run
// reported it (from the judge's scoring) and how close the reviewers came to it:
//
//   opened  a reviewer read at least one of its lines in the file, or a search hit one
//   diff    its lines were in the diff the reviewer saw, but it never read them in the file
//   file    a reviewer touched the file, but never those lines
//   none    no reviewer touched the file
//
// A miss the reviewer never read is a problem of where it looked. A miss it read is a
// problem of what it noticed or chose to report. The verifier and the fit assessment
// are left out, since only the reviewers propose findings.
//
// It reads context.json, which scripts/local-run.sh asks every run to write, and falls
// back to transcript.json for older runs. The table lands in runs/<run>/coverage.md.
// This is for the 25 pull request test set only, where reading misses is allowed.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ChatMessage } from "../src/llm.ts";
import type { ReadRecord } from "../src/tools.ts";

const here = resolve(import.meta.dirname, "..");
const bench = process.env.REVIEWBENCH_DIR ?? join(here, "..", "ReviewBench");
const name = process.argv[2];
if (!name) {
  console.error("usage: node scripts/coverage.ts <run>");
  process.exit(2);
}
const runDir = join(here, "runs", name);
const outDir = join(runDir, ".try-agent", "out");

interface Context { diff_in_prompt: boolean; readers: Array<{ caller: string; reads: ReadRecord[] }> }
interface Golden { file: string; start_line: number; end_line: number; message: string; tp_fp: string; severity: string; context_required?: string; difficulty?: string }
type Level = "opened" | "diff" | "file" | "none";

const readJson = async <T>(path: string): Promise<T | null> => {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return null; }
};

/** Rebuilds the read records from a recorded conversation, for runs made before context.json. */
function fromTranscript(transcript: { conversations: Array<{ caller: string; messages: ChatMessage[] }> }): Context {
  let diffInPrompt = false;
  const readers = transcript.conversations.map(({ caller, messages }) => {
    if (messages.some((message) => message.role === "user" && typeof message.content === "string" && message.content.includes("The full diff:\n\n<diff>"))) diffInPrompt = true;
    const results = new Map(messages.filter((message) => message.role === "tool").map((message) => [message.tool_call_id, message.content]));
    const reads: ReadRecord[] = [];
    for (const message of messages) {
      for (const call of (message.role === "assistant" && message.tool_calls) || []) {
        let args: Record<string, unknown> = {};
        let result: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments || "{}"); result = JSON.parse(String(results.get(call.id) ?? "{}")); } catch { continue; }
        if (result.ok !== true) continue;
        const tool = call.function.name;
        if (tool === "search") {
          const hits = (result.results as Array<{ path: string; line: number }> | undefined) ?? [];
          reads.push({ tool, query: String(args.query), hits: hits.map(({ path, line }) => ({ path, line })) });
          continue;
        }
        if (!["read_file", "read_base_file", "read_diff"].includes(tool)) continue;
        const numbers = String(result.content ?? "").split("\n").map((line) => Number(/^(\d+): /.exec(line)?.[1])).filter((value) => value > 0);
        const record: ReadRecord = { tool, ...(tool === "read_diff" ? {} : { path: String(args.path) }) };
        if (numbers.length) record.lines = [numbers[0]!, numbers.at(-1)!];
        reads.push(record);
      }
    }
    return { caller, reads };
  });
  return { diff_in_prompt: diffInPrompt, readers };
}

/** For each line of the diff, counting from 1, the file and head line it shows, if any. */
function diffLines(diff: string): Array<{ path: string; head: number | null } | null> {
  const lines: Array<{ path: string; head: number | null } | null> = [];
  let path = "";
  let head = 0;
  let inHunk = false;
  for (const text of diff.split("\n")) {
    if (text.startsWith("diff --git ")) { inHunk = false; lines.push(null); continue; }
    if (!inHunk && text.startsWith("+++ ")) { path = text.slice(4).trim().replace(/^"|"$/g, "").replace(/^b\//, ""); lines.push(null); continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { inHunk = true; head = Number(hunk[1]); lines.push({ path, head: null }); continue; }
    if (!inHunk) { lines.push(null); continue; }
    if (text.startsWith("-")) { lines.push({ path, head: null }); continue; }
    if (text.startsWith("\\")) { lines.push(null); continue; }
    lines.push({ path, head: head++ });
  }
  return lines;
}

function levelFor(finding: Golden, context: Context, diff: ReturnType<typeof diffLines>): Level {
  const reviewers = context.readers.filter(({ caller }) => !/^(verifier|fit)\b/.test(caller));
  const overlaps = (first: number, last: number) => first <= finding.end_line && last >= finding.start_line;
  let touched = false;
  const shownByDiff = (from: number, to: number): Level => {
    let level: Level = "none";
    for (let index = from; index <= Math.min(to, diff.length); index += 1) {
      const line = diff[index - 1];
      if (line?.path !== finding.file) continue;
      if (line.head !== null && overlaps(line.head, line.head)) return "diff";
      level = "file";
    }
    return level;
  };
  let inDiff = false;
  const fromDiff = (level: Level) => {
    if (level === "diff") inDiff = true;
    if (level !== "none") touched = true;
  };
  if (context.diff_in_prompt && reviewers.length) fromDiff(shownByDiff(1, diff.length));
  for (const { reads } of reviewers) {
    for (const read of reads) {
      if (read.tool === "read_diff" && read.lines) {
        fromDiff(shownByDiff(read.lines[0], read.lines[1]));
      } else if (read.tool === "read_file" && read.path === finding.file) {
        touched = true;
        if (read.lines && overlaps(read.lines[0], read.lines[1])) return "opened";
      } else if (read.tool === "read_base_file" && read.path === finding.file) {
        touched = true;
      } else if (read.tool === "search") {
        for (const hit of read.hits ?? []) {
          if (hit.path !== finding.file) continue;
          touched = true;
          if (overlaps(hit.line, hit.line)) return "opened";
        }
      }
    }
  }
  return inDiff ? "diff" : touched ? "file" : "none";
}

const scoring = await readJson<Array<{ pr_key: string; candidate_findings: Array<{ covered_golden_indices?: number[] }> }>>(join(runDir, "scoring", "results.details.json"));
if (!scoring) console.error(`no scoring for ${name}; run scripts/score.sh ${name} first to see which findings were reported`);
const found = new Map(scoring?.map((entry) => [entry.pr_key, new Set(entry.candidate_findings.flatMap((candidate) => candidate.covered_golden_indices ?? []))]) ?? []);

const rows: Array<{ key: string; finding: Golden; level: Level; reported: boolean }> = [];
for (const key of (await readdir(outDir)).sort()) {
  const golden = await readJson<{ findings: Golden[] }>(join(bench, "golden", `${key}.json`));
  if (!golden) { console.error(`${key}: no golden file, skipped`); continue; }
  const context = await readJson<Context>(join(outDir, key, "context.json"))
    ?? await readJson<{ conversations: Array<{ caller: string; messages: ChatMessage[] }> }>(join(outDir, key, "transcript.json")).then((transcript) => transcript && fromTranscript(transcript));
  if (!context) { console.error(`${key}: no context.json or transcript.json, skipped`); continue; }
  const diff = diffLines(await readFile(join(runDir, ".try-agent", "pr", key, "diff.patch"), "utf8"));
  for (const [index, finding] of golden.findings.entries()) {
    if (finding.tp_fp !== "tp") continue;
    rows.push({ key, finding, level: levelFor(finding, context, diff), reported: found.get(key)?.has(index) ?? false });
  }
}

const levels: Level[] = ["opened", "diff", "file", "none"];
const count = (filter: (row: typeof rows[number]) => boolean) => rows.filter(filter).length;
const percent = (part: number, whole: number) => whole ? `${Math.round((100 * part) / whole)}%` : "";
const table = (title: string, group: (row: typeof rows[number]) => string) => {
  const groups = [...new Set(rows.map(group))].sort();
  const lines = [`| ${title} | Expected | Reported | Missed, lines opened | Missed, lines only in diff | Missed, file only | Missed, file never touched |`, "|---|---|---|---|---|---|---|"];
  for (const value of groups) {
    const inGroup = rows.filter((row) => group(row) === value);
    const missed = (level: Level) => inGroup.filter((row) => !row.reported && row.level === level).length;
    const reported = inGroup.filter((row) => row.reported).length;
    lines.push(`| ${value} | ${inGroup.length} | ${reported} (${percent(reported, inGroup.length)}) | ${missed("opened")} | ${missed("diff")} | ${missed("file")} | ${missed("none")} |`);
  }
  return lines.join("\n");
};

const summary = [
  `# Coverage of expected findings in ${name}`,
  "",
  `${rows.length} expected findings. Reviewers opened the lines of ${count((row) => row.level === "opened")}, saw the lines of ${count((row) => row.level === "diff")} only in the diff, touched only the file of ${count((row) => row.level === "file")}, and never touched the file of ${count((row) => row.level === "none")}.`,
  "",
  table("All", () => "all"),
  "",
  table("Context required", (row) => row.finding.context_required ?? "unknown"),
  "",
  table("Severity", (row) => row.finding.severity),
].join("\n");

const missedRows = rows.filter((row) => !row.reported).sort((a, b) => levels.indexOf(a.level) - levels.indexOf(b.level) || a.key.localeCompare(b.key));
const details = [
  "## Missed findings",
  "",
  "| Pull request | Where | Reviewers | Severity | Context | Expected finding |",
  "|---|---|---|---|---|---|",
  ...missedRows.map(({ key, finding, level }) => `| ${key} | ${finding.file}:${finding.start_line}-${finding.end_line} | ${level} | ${finding.severity} | ${finding.context_required ?? ""} | ${finding.message.replace(/\s+/g, " ").replaceAll("|", "\\|").slice(0, 160)} |`),
].join("\n");

await writeFile(join(runDir, "coverage.md"), `${summary}\n\n${details}\n`);
console.log(summary);
console.log(`\nThe missed findings are listed in runs/${name}/coverage.md`);
