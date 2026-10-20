// Scores a run's grounded precision and recall with only the benchmark judge's
// matching step. The full judge also classifies every finding that matches no
// expected finding, one by one with tools, which is most of its time and cost,
// and that step feeds only the augmented scores. Grounded scores depend only on
// the matching, so this gives the same grounded numbers for a fraction of the cost.
//
// Run through scripts/score.sh with JUDGE_MODE=match, which sets up the judge's
// model registry and runs this from the ReviewBench clone so its modules load:
//
//   npx tsx <this file> <run-dir> <out-dir> <provider> <model> <concurrency>
//
// It writes results.json (macro and per pull request grounded scores, in the
// judge's field names) and results.details.json (which expected findings each
// finding covered, as scripts like misses.ts read it). Run again on the same
// output, it keeps the pull requests already scored and matches only the rest,
// so one that failed can be retried without matching the others a second time.
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const [runDir, outDir, provider, modelId, concurrencyText] = process.argv.slice(2);
if (!runDir || !outDir || !provider || !modelId) {
  console.error("usage: tsx scripts/match.ts <run-dir> <out-dir> <provider> <model> [concurrency]");
  process.exit(2);
}
const bench = process.cwd();
// Loaded by path from the ReviewBench clone, so the typecheck of this repository does not need it.
const pipeline = await import(join(bench, "scripts/golden/pipeline.ts"));
const matchTypes = await import(join(bench, "scripts/lib/match-types.ts"));

interface Golden { pr_key: string; findings: Array<{ tp_fp: string }> }
interface Candidate { findings: Array<Record<string, unknown>> }
interface Scored { pr_key: string; grounded_precision: number | null; grounded_recall: number | null; candidate_count: number; matched_count: number; matched_tp_count: number; golden_tp_count: number; golden_tp_covered: number; covered: number[][] }

const ATTEMPTS = 3;

async function scorePr(key: string): Promise<Scored> {
  const golden = JSON.parse(await readFile(join(bench, "golden", `${key}.json`), "utf8")) as Golden;
  const candidate = JSON.parse(await readFile(join(runDir!, "findings", `${key}.json`), "utf8")) as Candidate;
  let result: { correspondences: Array<{ candidate_index: number; matched_golden_indices: number[] }> } | null = null;
  for (let attempt = 1; !result; attempt += 1) {
    try {
      result = await pipeline.dedup(candidate.findings, golden, { matcher: { provider, modelId } });
    } catch (error) {
      if (attempt >= ATTEMPTS) throw error;
      console.log(`  ${key}: matching failed, trying again: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const scoring = matchTypes.resolveForScoring(result!.correspondences, golden.findings.length) as { matchedToGolden: Map<number, number>; coveredGolden: Set<number> };
  // The same arithmetic as computeMetrics in the judge's scripts/eval/scorer.ts.
  const tp = new Set(golden.findings.flatMap((finding, index) => finding.tp_fp === "tp" ? [index] : []));
  const matchedTp = [...scoring.matchedToGolden.values()].filter((index) => tp.has(index)).length;
  const covered = [...scoring.coveredGolden].filter((index) => tp.has(index)).length;
  const coveredBy = candidate.findings.map((_, index) => {
    const correspondence = result!.correspondences.find((item) => item.candidate_index === index);
    return correspondence ? [...new Set(correspondence.matched_golden_indices)].filter((gi) => Number.isInteger(gi) && gi >= 0 && gi < golden.findings.length).sort((a, b) => a - b) : [];
  });
  console.log(`  ${key}: ${scoring.matchedToGolden.size} of ${candidate.findings.length} findings matched, ${covered} of ${tp.size} expected found`);
  return {
    pr_key: key, candidate_count: candidate.findings.length,
    matched_count: scoring.matchedToGolden.size, matched_tp_count: matchedTp, golden_tp_count: tp.size, golden_tp_covered: covered,
    grounded_precision: scoring.matchedToGolden.size ? matchedTp / scoring.matchedToGolden.size : null,
    grounded_recall: tp.size ? covered / tp.size : null,
    covered: coveredBy,
  };
}

const keys = (await readdir(join(runDir, "findings"))).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).sort();
const limit = Math.max(1, Number(concurrencyText) || 25);
const results: Scored[] = [];
// Pull requests an earlier pass already scored, with what each finding covered.
try {
  const earlier = JSON.parse(await readFile(resolve(outDir, "results.json"), "utf8")) as { per_pr: Array<{ pr_key: string; metrics: { overall: Omit<Scored, "covered"> } }> };
  const details = JSON.parse(await readFile(resolve(outDir, "results.details.json"), "utf8")) as Array<{ pr_key: string; candidate_findings: Array<{ covered_golden_indices: number[] }> }>;
  for (const entry of earlier.per_pr) {
    const covered = details.find((item) => item.pr_key === entry.pr_key)?.candidate_findings.map((finding) => finding.covered_golden_indices);
    if (covered && keys.includes(entry.pr_key)) results.push({ ...entry.metrics.overall, covered });
  }
  if (results.length) console.log(`  keeping ${results.length} pull request(s) scored before`);
} catch {
  // Nothing scored yet.
}
const todo = keys.filter((key) => !results.some((item) => item.pr_key === key));
let next = 0;
let failed = 0;
await Promise.all(Array.from({ length: Math.min(limit, todo.length) }, async () => {
  while (next < todo.length) {
    const key = todo[next++]!;
    try {
      results.push(await scorePr(key));
    } catch (error) {
      failed += 1;
      console.log(`  ${key}: FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}));
results.sort((a, b) => a.pr_key.localeCompare(b.pr_key));

const average = (values: Array<number | null>): number | null => {
  const valid = values.filter((value): value is number => value !== null);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
};
const macro = { overall: { grounded_precision: average(results.map((item) => item.grounded_precision)), grounded_recall: average(results.map((item) => item.grounded_recall)) } };
await mkdir(outDir, { recursive: true });
await writeFile(resolve(outDir, "results.json"), `${JSON.stringify({
  step: "matching only; the augmented scores are not computed", judge: `${provider}/${modelId}`, pr_count: results.length, macro,
  per_pr: results.map(({ covered: _covered, ...item }) => ({ pr_key: item.pr_key, metrics: { overall: item } })),
}, null, 2)}\n`);
await writeFile(resolve(outDir, "results.details.json"), `${JSON.stringify(results.map((item) => ({
  pr_key: item.pr_key, candidate_findings: item.covered.map((indices) => ({ covered_golden_indices: indices })),
})), null, 2)}\n`);
const { grounded_precision: p, grounded_recall: r } = macro.overall;
console.log(`Grounded (macro): P=${p === null ? "-" : (100 * p).toFixed(1)}% R=${r === null ? "-" : (100 * r).toFixed(1)}% F1=${p && r ? (200 * p * r / (p + r)).toFixed(1) : "-"}% over ${results.length} pull request(s)`);
if (failed) {
  console.log(`${failed} pull request(s) failed; refusing to report a partial score as complete`);
  process.exit(1);
}
