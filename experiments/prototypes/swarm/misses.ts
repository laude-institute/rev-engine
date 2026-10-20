// Sorts every expected finding a swarm run missed by the step that lost it.
//
//   node experiments/prototypes/swarm/misses.ts <run>
//
// It reads the judge's scoring, the benchmark's golden files, and each pull request's
// swarm.json and context.json. A miss falls into the first case that fits:
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

const here = resolve(import.meta.dirname, "../../..");
const bench = process.env.REVIEWBENCH_DIR ?? join(here, "..", "ReviewBench");
const name = process.argv[2];
if (!name) {
  console.error("usage: node experiments/prototypes/swarm/misses.ts <run>");
  process.exit(2);
}
const runDir = join(here, "runs", name);
const outDir = join(runDir, ".try-agent", "out");
/** Must match WINDOW_LINES in chunks.ts: chunk agents see this many lines around each unit. */
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

const scoring = await readJson<Array<{ pr_key: string; candidate_findings: Array<{ covered_golden_indices?: number[] }> }>>(join(runDir, "scoring", "results.details.json"));
if (!scoring) {
  console.error(`no scoring for ${name}; run scripts/score.sh ${name} first`);
  process.exit(1);
}
const found = new Map(scoring.map((entry) => [entry.pr_key, new Set(entry.candidate_findings.flatMap((candidate) => candidate.covered_golden_indices ?? []))]));

const rows: Array<{ key: string; finding: Golden; reported: boolean; case: Case | null; evidence: string }> = [];
for (const key of (await readdir(outDir)).sort()) {
  const golden = await readJson<{ findings: Golden[] }>(join(bench, "golden", `${key}.json`));
  const trace = await readJson<Trace>(join(outDir, key, "swarm.json"));
  const context = await readJson<{ readers: Array<{ caller: string; reads: ReadRecord[] }> }>(join(outDir, key, "context.json"));
  if (!golden || !trace) { console.error(`${key}: no golden file or swarm.json, skipped`); continue; }
  const finalIds = new Set(trace.final.map((item) => item.findingId));
  const cut = new Set(trace.cutByCap);
  const votes = new Map(trace.verification.map((item) => [item.findingId, item]));

  for (const [index, finding] of golden.findings.entries()) {
    if (finding.tp_fp !== "tp") continue;
    const reported = found.get(key)?.has(index) ?? false;
    if (reported) { rows.push({ key, finding, reported, case: null, evidence: "" }); continue; }
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
      const chunkAgents = trace.agents.filter((agent) => inWindow.some((id) => agent.caller.startsWith(`${id}/`))).map((agent) => agent.caller);
      const saw = [...new Set([...chunkAgents.map((caller) => `${caller} (prompt)`), ...readers])];
      missCase = saw.length ? "read" : "unseen";
      evidence = saw.length ? saw.join(", ") : "no chunk window or read covered these lines";
    }
    rows.push({ key, finding, reported, case: missCase, evidence });
  }
}

const missed = rows.filter((row) => !row.reported);
const summary = [
  `# Misses in ${name}`,
  "",
  `${rows.length} expected findings, ${rows.length - missed.length} reported, ${missed.length} missed.`,
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
  "| Case | Pull request | Where | Severity | Expected finding | Evidence |",
  "|---|---|---|---|---|---|",
  ...missed.sort((a, b) => CASES.indexOf(a.case!) - CASES.indexOf(b.case!) || a.key.localeCompare(b.key)).map((row) =>
    `| ${row.case} | ${row.key} | ${row.finding.file}:${row.finding.start_line}-${row.finding.end_line} | ${row.finding.severity} | ${cell(row.finding.message)} | ${cell(row.evidence, 400)} |`),
].join("\n");

await writeFile(join(runDir, "misses.md"), `${summary}\n\n${details}\n`);
console.log(summary);
console.log(`\nEach miss is listed in runs/${name}/misses.md`);
