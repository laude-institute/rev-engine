// Sorts every expected finding a swarm run missed by the step that lost it.
//
//   node experiments/prototypes/swarm/misses.ts <run> [scoring-name...]
//
// It reads the judge's scoring, the benchmark's golden files, and each pull request's
// swarm.json, context.json and transcript.json. The scoring names are directories under the
// run, such as matching and matching2; the default is scoring, or matching when the run has
// no scoring. With several, a finding counts as missed when any of them missed it, and the
// report says whether all of them did, because the judge's matching varies from pass to pass.
// A miss falls into the first case that fits:
//
//   reported   a final finding sits on the same lines, but the judge did not match it
//   cut        a finding on the same lines survived verification and the cap cut it
//   voted out  a finding on the same lines was rejected or marked a repeat by the verifiers
//   read       no finding sat on its lines, but an agent read them or had them in its prompt
//   unseen     no agent read its lines
//
// "Same lines" means the same file within three lines, which is a guess: only the judge
// knows what matches. For the 25 pull request test set only, where reading misses is allowed.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ReadRecord } from "../../../src/tools.ts";
import { promptLines, sawLines, type Seen } from "./seen.ts";

const here = resolve(import.meta.dirname, "../../..");
const bench = process.env.REVIEWBENCH_DIR ?? join(here, "..", "ReviewBench");
const [name, ...scoringNames] = process.argv.slice(2);
if (!name) {
  console.error("usage: node experiments/prototypes/swarm/misses.ts <run> [scoring-name...]");
  process.exit(2);
}
const runDir = join(here, "runs", name);
const outDir = join(runDir, ".try-agent", "out");
/** Must match WINDOW_LINES in chunks.ts: chunk agents see this many lines around each unit. Used only for runs without a transcript. */
const WINDOW = 30;
const NEAR = 3;

interface Golden { file: string; start_line: number; end_line: number; message: string; tp_fp: string; severity: string }
interface Ballot { voter: string; verdict: string | null; reason: string | null; duplicateOf: string | null }
interface Trace {
  chunks: Array<{ id: string; units: Array<{ path: string; hunks: Array<[number, number]> }> }>;
  agents: Array<{ caller: string; status: string }>;
  proposals: Array<{ id: string; caller: string; file: string; startLine: number; endLine: number; title: string; findingId: string | null }>;
  verification: Array<{ findingId: string; kept: boolean; ballots: Ballot[] }>;
  final: Array<{ findingId: string; title: string }>;
  cutByCap: string[];
}
type Case = "reported" | "cut" | "voted out" | "read" | "unseen";
const CASES: Case[] = ["reported", "cut", "voted out", "read", "unseen"];

const readJson = async <T>(path: string): Promise<T | null> => {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return null; }
};
const cell = (text: string, max = 160) => text.replace(/\s+/g, " ").replaceAll("|", "\\|").slice(0, max);

type Details = Array<{ pr_key: string; candidate_findings: Array<{ covered_golden_indices?: number[] }> }>;
const names = scoringNames.length ? scoringNames
  : await readJson<Details>(join(runDir, "scoring", "results.details.json")) ? ["scoring"] : ["matching"];
const passes: Array<Map<string, Set<number>>> = [];
for (const scoringName of names) {
  const scoring = await readJson<Details>(join(runDir, scoringName, "results.details.json"));
  if (!scoring) {
    console.error(`no ${scoringName} for ${name}; run scripts/score.sh ${name} first`);
    process.exit(1);
  }
  passes.push(new Map(scoring.map((entry) => [entry.pr_key, new Set(entry.candidate_findings.flatMap((candidate) => candidate.covered_golden_indices ?? []))])));
}

const rows: Array<{ key: string; index: number; finding: Golden; reported: boolean; missedByAll: boolean; case: Case | null; evidence: string }> = [];
for (const key of (await readdir(outDir)).sort()) {
  const golden = await readJson<{ findings: Golden[] }>(join(bench, "golden", `${key}.json`));
  const trace = await readJson<Trace>(join(outDir, key, "swarm.json"));
  const context = await readJson<{ readers: Array<{ caller: string; reads: ReadRecord[] }> }>(join(outDir, key, "context.json"));
  if (!golden || !trace) { console.error(`${key}: no golden file or swarm.json, skipped`); continue; }
  // What each reviewing agent had in its prompt, when the run kept a transcript.
  const transcript = await readJson<{ conversations: Array<{ caller: string; messages: Array<{ role: string; content?: string | null }> }> }>(join(outDir, key, "transcript.json"));
  const prompts: Array<{ caller: string; seen: Seen }> | null = transcript
    ? transcript.conversations.filter((conversation) => !conversation.caller.startsWith("verifier") && !conversation.caller.startsWith("merge"))
      .map((conversation) => ({ caller: conversation.caller, seen: promptLines(conversation.messages.find((message) => message.role === "user")?.content ?? "") }))
    : null;
  const finalIds = new Set(trace.final.map((item) => item.findingId));
  const cut = new Set(trace.cutByCap);
  const votes = new Map(trace.verification.map((item) => [item.findingId, item]));

  for (const [index, finding] of golden.findings.entries()) {
    if (finding.tp_fp !== "tp") continue;
    const foundBy = passes.filter((pass) => pass.get(key)?.has(index)).length;
    const reported = foundBy === passes.length;
    if (reported) { rows.push({ key, index, finding, reported, missedByAll: false, case: null, evidence: "" }); continue; }
    const missedByAll = foundBy === 0;
    const overlaps = (first: number, last: number, slack = 0) => first - slack <= finding.end_line && last + slack >= finding.start_line;

    const near = trace.proposals.filter((proposal) => proposal.file === finding.file && overlaps(proposal.startLine, proposal.endLine, NEAR));
    const fates = near.map((proposal) => ({
      proposal,
      fate: !proposal.findingId ? "voted out"
        : finalIds.has(proposal.findingId) ? "reported"
        : cut.has(proposal.findingId) ? "cut"
        : "voted out",
    }));
    const listed = (fate: string) => fates.filter((item) => item.fate === fate).map(({ proposal }) => `${proposal.caller}: ${cell(proposal.title, 90)}`);
    let missCase: Case;
    let evidence: string;
    if (fates.some((item) => item.fate === "reported")) {
      missCase = "reported";
      evidence = listed("reported").join("; ");
    } else if (fates.some((item) => item.fate === "cut")) {
      missCase = "cut";
      evidence = listed("cut").join("; ");
    } else if (fates.length) {
      missCase = "voted out";
      const reasons = [...new Set(near.flatMap((proposal) => (proposal.findingId ? votes.get(proposal.findingId)?.ballots ?? [] : [])
        .filter((ballot) => ballot.verdict === "rejected" || ballot.duplicateOf).map((ballot) => `${ballot.verdict}${ballot.duplicateOf ? ` (repeat of ${ballot.duplicateOf})` : ""}: ${cell(ballot.reason ?? "", 90)}`)))];
      evidence = `${listed("voted out").join("; ")}. Votes: ${reasons.join("; ") || "none recorded"}`;
    } else {
      const inWindow = trace.chunks.filter((piece) => piece.units.some((unit) => unit.path === finding.file
        && unit.hunks.some(([start, end]) => overlaps(start, end, WINDOW)))).map((piece) => piece.id);
      const readers = (context?.readers ?? []).filter(({ caller, reads }) => !caller.startsWith("verifier") && reads.some((read) =>
        (read.tool === "read_file" && read.path === finding.file && read.lines && overlaps(read.lines[0], read.lines[1]))
        || (read.tool === "search" && (read.hits ?? []).some((hit) => hit.path === finding.file && overlaps(hit.line, hit.line))))).map(({ caller }) => caller);
      const shown = prompts
        ? prompts.flatMap(({ caller, seen }) => {
          const sources = sawLines(seen, finding.file, finding.start_line - NEAR, finding.end_line + NEAR);
          return sources.length ? [`${caller} (prompt: ${sources.join(", ")})`] : [];
        })
        : trace.agents.filter((agent) => inWindow.some((id) => agent.caller.startsWith(`${id}/`))).map((agent) => `${agent.caller} (prompt)`);
      const saw = [...new Set([...shown, ...readers.map((caller) => `${caller} (read)`)])];
      missCase = saw.length ? "read" : "unseen";
      evidence = saw.length ? saw.join(", ") : "no chunk window or read covered these lines";
    }
    rows.push({ key, index, finding, reported, missedByAll, case: missCase, evidence });
  }
}

const missed = rows.filter((row) => !row.reported);
const summary = [
  `# Misses in ${name}`,
  "",
  `${rows.length} expected findings, ${rows.length - missed.length} reported, ${missed.length} missed`
    + (passes.length > 1 ? `, of which ${missed.filter((row) => row.missedByAll).length} were missed in all ${passes.length} matchings (${names.join(", ")}).` : "."),
  "",
  "| Case | Missed | High | Medium | Low |",
  "|---|---|---|---|---|",
  ...CASES.map((value) => {
    const inCase = missed.filter((row) => row.case === value);
    const by = (severity: string) => inCase.filter((row) => row.finding.severity === severity).length;
    return `| ${value} | ${inCase.length} | ${by("high")} | ${by("medium")} | ${by("low")} |`;
  }),
].join("\n");
const details = [
  "## Missed findings",
  "",
  "| Case | Pull request | Where | Severity | Missed in every matching | Expected finding | Evidence |",
  "|---|---|---|---|---|---|---|",
  ...missed.sort((a, b) => CASES.indexOf(a.case!) - CASES.indexOf(b.case!) || a.key.localeCompare(b.key)).map((row) =>
    `| ${row.case} | ${row.key} | ${row.finding.file}:${row.finding.start_line}-${row.finding.end_line} | ${row.finding.severity} | ${row.missedByAll ? "yes" : "no"} | ${cell(row.finding.message)} | ${cell(row.evidence, 400)} |`),
].join("\n");

await writeFile(join(runDir, "misses.md"), `${summary}\n\n${details}\n`);
// The same rows in full, for tools that build on them.
await writeFile(join(runDir, "misses.json"), `${JSON.stringify(missed.map(({ key, index, finding, missedByAll, case: missCase, evidence }) =>
  ({ pr_key: key, golden_index: index, file: finding.file, start_line: finding.start_line, end_line: finding.end_line, severity: finding.severity, message: finding.message, missed_by_all: missedByAll, case: missCase, evidence })), null, 2)}\n`);
console.log(summary);
console.log(`\nEach miss is listed in runs/${name}/misses.md`);
