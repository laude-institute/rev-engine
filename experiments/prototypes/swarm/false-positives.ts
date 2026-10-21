// Lists every finding a swarm run reported that the judge matched only to expected findings
// the benchmark marks as wrong, with the agents that proposed it and the verifiers' votes.
//
//   node experiments/prototypes/swarm/false-positives.ts <run> [scoring-name...]
//
// The scoring names work as in misses.ts. With several, a finding counts when any matching
// paired it only with wrong expected findings, and the report says whether all of them did.
// It reads the judge's raw pairings, before the score settles which pairing counts, so its
// count can be a little higher than the wrong matches behind the score.
// It writes runs/<run>/false-positives.md and false-positives.json. For the 25 pull request
// test set only, where reading results finding by finding is allowed.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const here = resolve(import.meta.dirname, "../../..");
const bench = process.env.REVIEWBENCH_DIR ?? join(here, "..", "ReviewBench");
const [name, ...scoringNames] = process.argv.slice(2);
if (!name) {
  console.error("usage: node experiments/prototypes/swarm/false-positives.ts <run> [scoring-name...]");
  process.exit(2);
}
const runDir = join(here, "runs", name);
const outDir = join(runDir, ".try-agent", "out");

interface Golden { message: string; tp_fp: string; severity: string; category?: string; tp_fp_justification?: string }
interface Ballot { voter: string; verdict: string | null; reason: string | null }
interface Trace {
  agents: Array<{ caller: string; tasks: string[] }>;
  proposals: Array<{ id: string; caller: string; title: string; findingId: string | null }>;
  verification: Array<{ findingId: string; ballots: Ballot[] }>;
  final: Array<{ findingId: string; rank: number; file: string; startLine: number; endLine: number; severity: string; kind: string; title: string; support: number; from: string[] }>;
}
type Details = Array<{ pr_key: string; candidate_findings: Array<{ covered_golden_indices?: number[] }> }>;

const readJson = async <T>(path: string): Promise<T | null> => {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return null; }
};
const cell = (text: string, max = 160) => text.replace(/\s+/g, " ").replaceAll("|", "\\|").slice(0, max);

const names = scoringNames.length ? scoringNames
  : await readJson<Details>(join(runDir, "scoring", "results.details.json")) ? ["scoring"] : ["matching"];
const passes: Array<Map<string, number[][]>> = [];
for (const scoringName of names) {
  const scoring = await readJson<Details>(join(runDir, scoringName, "results.details.json"));
  if (!scoring) {
    console.error(`no ${scoringName} for ${name}; run scripts/score.sh ${name} first`);
    process.exit(1);
  }
  passes.push(new Map(scoring.map((entry) => [entry.pr_key, entry.candidate_findings.map((candidate) => candidate.covered_golden_indices ?? [])])));
}

interface Row {
  pr_key: string; rank: number; file: string; start_line: number; end_line: number; severity: string; kind: string; title: string;
  support: number; wrong_in_every_matching: boolean;
  proposers: Array<{ caller: string; tasks: string[]; title: string }>;
  votes: Ballot[];
  expected: Array<{ golden_index: number; message: string; severity: string; category: string; why_wrong: string }>;
}
const rows: Row[] = [];
for (const key of (await readdir(outDir)).sort()) {
  const golden = await readJson<{ findings: Golden[] }>(join(bench, "golden", `${key}.json`));
  const trace = await readJson<Trace>(join(outDir, key, "swarm.json"));
  if (!golden || !trace) { console.error(`${key}: no golden file or swarm.json, skipped`); continue; }
  const tasks = new Map(trace.agents.map((agent) => [agent.caller, agent.tasks]));
  const votes = new Map(trace.verification.map((item) => [item.findingId, item.ballots]));
  for (const [position, final] of trace.final.entries()) {
    // Wrong in a matching: matched, and only to expected findings marked wrong.
    const wrongIn = passes.map((pass) => {
      const covered = pass.get(key)?.[position] ?? [];
      return covered.length > 0 && covered.every((index) => golden.findings[index]?.tp_fp !== "tp") ? covered : null;
    });
    const wrong = wrongIn.filter((covered) => covered !== null);
    if (!wrong.length) continue;
    const proposers = trace.proposals.filter((proposal) => final.from.includes(proposal.id))
      .map((proposal) => ({ caller: proposal.caller, tasks: tasks.get(proposal.caller) ?? [], title: proposal.title }));
    rows.push({
      pr_key: key, rank: final.rank, file: final.file, start_line: final.startLine, end_line: final.endLine,
      severity: final.severity, kind: final.kind, title: final.title, support: final.support,
      wrong_in_every_matching: wrong.length === passes.length,
      proposers, votes: votes.get(final.findingId) ?? [],
      expected: [...new Set(wrong.flat())].map((index) => ({
        golden_index: index, message: golden.findings[index]!.message, severity: golden.findings[index]!.severity,
        category: golden.findings[index]!.category ?? "", why_wrong: golden.findings[index]!.tp_fp_justification ?? "",
      })),
    });
  }
}

const tally = (values: string[]) => [...values.reduce((counts, value) => counts.set(value, (counts.get(value) ?? 0) + 1), new Map<string, number>())]
  .sort((a, b) => b[1] - a[1]).map(([value, count]) => `${value} ${count}`).join(", ");
const confirmed = (row: Row) => row.votes.filter((ballot) => ballot.verdict === "confirmed").length;
const summary = [
  `# False positives in ${name}`,
  "",
  `${rows.length} reported findings were matched only to expected findings marked wrong`
    + (passes.length > 1 ? `, ${rows.filter((row) => row.wrong_in_every_matching).length} of them in all ${passes.length} matchings (${names.join(", ")}).` : "."),
  "",
  `- Tasks of the agents that proposed them: ${tally(rows.flatMap((row) => [...new Set(row.proposers.flatMap((proposer) => proposer.tasks))]))}`,
  `- Kind: ${tally(rows.map((row) => row.kind))}`,
  `- Severity: ${tally(rows.map((row) => row.severity))}`,
  `- Agents behind each: ${tally(rows.map((row) => String(row.support)))}`,
  `- Verifiers that confirmed each: ${tally(rows.map((row) => String(confirmed(row))))}`,
  `- Category of the expected finding: ${tally(rows.flatMap((row) => row.expected.map((item) => item.category || "none")))}`,
].join("\n");
const details = [
  "## Findings",
  "",
  "| Pull request | Where | Severity and kind | In every matching | Finding | Proposed by | Votes | Why the benchmark marks it wrong |",
  "|---|---|---|---|---|---|---|---|",
  ...rows.map((row) => `| ${row.pr_key} | ${row.file}:${row.start_line}-${row.end_line} | ${row.severity} ${row.kind} | ${row.wrong_in_every_matching ? "yes" : "no"} | ${cell(row.title)} | ${row.proposers.map((proposer) => proposer.caller).join(", ")} | ${row.votes.map((ballot) => ballot.verdict ?? "none").join(", ")} | ${cell(row.expected.map((item) => item.why_wrong).join(" / "), 300)} |`),
].join("\n");
await writeFile(join(runDir, "false-positives.md"), `${summary}\n\n${details}\n`);
await writeFile(join(runDir, "false-positives.json"), `${JSON.stringify(rows, null, 2)}\n`);
console.log(summary);
console.log(`\nEach finding is listed in runs/${name}/false-positives.md`);
