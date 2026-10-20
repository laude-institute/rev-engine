// Writes the eval cases as a ReviewBench golden set and manifest, so the
// benchmark's judging CLI can score reviews of them.
//
//   node evals/export.ts <name> [--case <id>]... [--run <eval run name>]
//
// Output lands in runs/reviewbench/<name>/: golden/, manifest.json and, with
// --run, candidates/run-N/ holding each run's findings. Judge one run-N folder
// at a time, because the judging CLI merges every file it is given for a pull
// request into one review.
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCase, type EvalCase } from "./lib.ts";
import { toReviewBench } from "./reviewbench.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const name = argv[0] && !argv[0].startsWith("--") ? argv[0] : "";
if (!name) throw new Error("usage: node evals/export.ts <name> [--case <id>]... [--run <eval run name>]");
const only = argv.flatMap((value, index) => (argv[index - 1] === "--case" ? [value] : []));
const run = argv.includes("--run") ? argv[argv.indexOf("--run") + 1] : undefined;

const cases: EvalCase[] = [];
for (const folder of ["evals/cases", "evals/private"]) {
  const directory = join(root, folder);
  if (!existsSync(directory)) continue;
  for (const file of (await readdir(directory)).filter((entry) => entry.endsWith(".json")).sort()) {
    const parsed = parseCase(JSON.parse(await readFile(join(directory, file), "utf8")), `${folder}/${file}`);
    if (!only.length || only.includes(parsed.id)) cases.push(parsed);
  }
}
const missing = only.filter((id) => !cases.some((item) => item.id === id));
if (missing.length) throw new Error(`no case with the id ${missing.join(", ")}`);

const out = join(root, "runs/reviewbench", name);
await rm(out, { recursive: true, force: true });
await mkdir(join(out, "golden"), { recursive: true });
const manifest = [];
for (const evalCase of cases) {
  const { golden, manifest: entry, skipped } = toReviewBench(evalCase);
  await writeFile(join(out, "golden", `${golden.pr_key}.json`), `${JSON.stringify(golden, null, 2)}\n`);
  manifest.push(entry);
  console.log(`${evalCase.id}: ${golden.findings.length} finding(s) exported${skipped.length ? `, ${skipped.length} skipped` : ""}`);
  for (const { id, reason } of skipped) console.log(`  skipped ${id}: ${reason}`);

  if (!run) continue;
  const runDirectory = join(root, "runs/evals", run, evalCase.id);
  if (!existsSync(runDirectory)) {
    console.log(`  no reviews of this case in runs/evals/${run}`);
    continue;
  }
  for (const attempt of (await readdir(runDirectory)).filter((entry) => /^run-\d+$/.test(entry))) {
    const findings = join(runDirectory, attempt, "findings.json");
    if (!existsSync(findings)) continue;
    await mkdir(join(out, "candidates", attempt), { recursive: true });
    await copyFile(findings, join(out, "candidates", attempt, `${golden.pr_key}.json`));
  }
}
await writeFile(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote runs/reviewbench/${name}/ with ${cases.length} case(s)`);
console.log(`score one review round from the ReviewBench checkout with:
  npm run judge -- --candidate ${out}/candidates/run-1 --golden ${out}/golden --manifest ${out}/manifest.json --provider openrouter --model <judge model> --output ${out}/scoring/run-1.json --repo-dir ${join(root, "runs/.cache/reviewbench-repos")}`);
