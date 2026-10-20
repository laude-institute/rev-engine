import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import type { Finding } from "../action/comments.ts";
import { adviceLabel, parseCase, renderReport, scoreCase, totals, type EvalCase, type RunResult } from "../evals/lib.ts";
import { prKey, toReviewBench } from "../evals/reviewbench.ts";

const CASE: EvalCase = {
  id: "demo-1", repo: "owner/repo", pr: 1, base: "a".repeat(40), head: "b".repeat(40), title: "T", body: "", source: "a person",
  fit: "fits", advice: ["fix, then merge"],
  findings: [
    { id: "bug", label: "must", what: "The sign is wrong.", kind: "defect", min_severity: "medium" },
    { id: "nit", label: "valid", what: "A name is unclear." },
    { id: "wrong", label: "invalid", what: "Claims a link is stale." },
    { id: "later", label: "unlabeled", what: "Not judged yet." },
  ],
};

const finding = (severity: Finding["severity"], kind: string, title: string): Finding => ({ file: "a.ts", start_line: 1, end_line: 1, severity, kind, title, detail: "" });
const run = (findings: Finding[], matches: RunResult["matches"], fit: string | null = "fits"): RunResult => ({ findings, fit, costUsd: 0.5, seconds: 60, matches });

test("every case file in the repository is well formed", () => {
  for (const file of readdirSync("evals/cases").filter((name) => name.endsWith(".json"))) {
    const parsed = parseCase(JSON.parse(readFileSync(`evals/cases/${file}`, "utf8")), file);
    assert.equal(`${parsed.id}.json`, file);
  }
});

test("rejects a malformed case", () => {
  assert.throws(() => parseCase({ ...CASE, head: "abc" }, "x"), /full commit ids/);
  assert.throws(() => parseCase({ ...CASE, findings: [{ id: "a", label: "maybe", what: "w" }] }, "x"), /label/);
  assert.throws(() => parseCase({ ...CASE, findings: [CASE.findings[0], CASE.findings[0]] }, "x"), /share the id/);
});

test("accepts where a finding came from and who judged it", () => {
  const sha = "c".repeat(40);
  const traced = parseCase({
    ...CASE,
    reviews: [{ producer: "rev-engine-prime", model: "m", ref: "https://example.com/r/1", commit: CASE.head, fit: "fits" }],
    fixes: [sha],
    findings: [{
      id: "bug", label: "must", what: "w", file: "a.ts", start_line: 3, end_line: 5, severity: "high", category: "correctness",
      found_by: [{ type: "rev-engine-prime", severity: "medium", text: "t" }, { type: "author-fix", ref: sha }],
      judged_by: { type: "maintainer", quote: "fix it", date: "2026-10-20" },
      fixed_in: sha,
    }],
  }, "x");
  assert.equal(traced.findings[0]!.found_by?.length, 2);
});

test("rejects malformed sources, lines and severities", () => {
  const withFinding = (extra: Record<string, unknown>) => ({ ...CASE, findings: [{ id: "a", label: "must", what: "w", ...extra }] });
  assert.throws(() => parseCase(withFinding({ found_by: [{ type: "a guess" }] }), "x"), /found_by type/);
  assert.throws(() => parseCase(withFinding({ judged_by: { type: "me" } }), "x"), /judged_by type/);
  assert.throws(() => parseCase(withFinding({ start_line: 4 }), "x"), /both start_line and end_line/);
  assert.throws(() => parseCase(withFinding({ start_line: 4, end_line: 2 }), "x"), /ends before it starts/);
  assert.throws(() => parseCase(withFinding({ severity: "huge" }), "x"), /unknown severity/);
  assert.throws(() => parseCase(withFinding({ category: "vibes" }), "x"), /category/);
  assert.throws(() => parseCase(withFinding({ fixed_in: "abc" }), "x"), /fixed_in/);
  assert.throws(() => parseCase({ ...CASE, reviews: [{ producer: "r", commit: "abc" }] }, "x"), /review's commit/);
  assert.throws(() => parseCase({ ...CASE, fixes: ["abc"] }, "x"), /fixes/);
});

test("uses the judged severity as the expected minimum when no minimum is set", () => {
  const judged: EvalCase = { ...CASE, findings: [{ id: "bug", label: "must", what: "w", severity: "medium" }] };
  const score = scoreCase(judged, [run([finding("high", "defect", "A")], { bug: [0] }), run([finding("low", "defect", "A")], { bug: [0] })]);
  assert.equal(score.expectations[0]!.severityRight, 1);
});

test("exports a case as a ReviewBench golden set", () => {
  const located: EvalCase = {
    ...CASE,
    findings: [
      { id: "bug", label: "must", what: "The sign is wrong.", file: "a.ts", start_line: 2, end_line: 4, kind: "defect", severity: "high", note: "the maintainer", found_by: [{ type: "rev-engine-prime", producer: "m" }], judged_by: { type: "maintainer" } },
      { id: "nit", label: "valid", what: "A name is unclear.", file: "b.ts", start_line: 1, end_line: 1, min_severity: "low", category: "maintainability" },
      { id: "wrong", label: "invalid", what: "Claims a link is stale.", file: "c.md", start_line: 7, end_line: 7 },
      { id: "nowhere", label: "must", what: "No location.", file: "d.ts", severity: "medium" },
      { id: "unrated", label: "valid", what: "No severity.", file: "e.ts", start_line: 1, end_line: 1 },
      { id: "later", label: "unlabeled", what: "Not judged yet." },
    ],
  };
  const { golden, manifest, skipped } = toReviewBench(located);
  assert.equal(golden.pr_key, prKey("owner/repo", 1, "b".repeat(40)));
  assert.equal(golden.pr_key, "owner_repo_1-bbbbbbbb");
  assert.deepEqual(golden.findings.map((entry) => [entry.file, entry.tp_fp, entry.severity, entry.category, entry.producer]), [
    ["a.ts", "tp", "high", "correctness", "m"],
    ["b.ts", "tp", "low", "maintainability", "eval-case"],
    ["c.md", "fp", "low", "other", "eval-case"],
  ]);
  assert.deepEqual(golden.findings[0]!.source, { type: "eval_case", label: "must", found_by: ["rev-engine-prime"], judged_by: "maintainer" });
  assert.deepEqual(skipped.map((entry) => entry.id), ["nowhere", "unrated", "later"]);
  assert.equal(manifest.nwo, "owner/repo");
  assert.equal(manifest.pr_url, "https://github.com/owner/repo/pull/1");
});

test("derives the merge advice the action would show", () => {
  assert.equal(adviceLabel(run([finding("high", "defect", "A")], {})), "fix, then merge");
  assert.equal(adviceLabel(run([finding("medium", "test", "A")], {})), "merge and fast-follow");
  assert.equal(adviceLabel(run([], {}, "unclear")), "needs a maintainer's decision");
});

test("counts how often each labeled finding was reported, and how", () => {
  const results = [
    run([finding("high", "defect", "Sign"), finding("low", "documentation", "Other")], { bug: [0], nit: [], wrong: [] }),
    run([finding("low", "test", "Sign as a test"), finding("low", "documentation", "Stale link")], { bug: [0], nit: [], wrong: [1] }),
    // A problem split into two findings counts as right when either part has the expected kind and severity.
    run([finding("low", "maintainability", "Sign, part one"), finding("medium", "defect", "Sign, part two")], { bug: [0, 1], nit: [], wrong: [] }),
    { ...run([], {}), error: "the review failed" },
  ];
  const score = scoreCase(CASE, results);
  assert.equal(score.runs, 3);
  assert.equal(score.failed, 1);
  assert.deepEqual(score.expectations.map((entry) => [entry.expectation.id, entry.reported, entry.kindRight, entry.severityRight]), [
    ["bug", 3, 2, 2], ["nit", 0, null, null], ["wrong", 1, null, null],
  ]);
  assert.equal(score.fitRight, 3);
  assert.equal(score.adviceRight, 1);
  assert.deepEqual(score.advice, { "fix, then merge": 1, merge: 1, "merge and fast-follow": 1 });
  assert.deepEqual(score.unlabeled.map((entry) => entry.title), ["Other"]);
  assert.equal(score.costUsd, 2);

  const sum = totals([score]);
  assert.deepEqual([sum.mustReported, sum.mustPossible, sum.invalidReported, sum.invalidPossible, sum.kindRight, sum.kindChecked], [3, 3, 1, 3, 2, 3]);

  const report = renderReport("demo", "Settings line.", [score], 0.02);
  assert.match(report, /Findings every review should report: 3 of 3 reported\./);
  assert.match(report, /Findings known to be wrong: 1 of 3 reported\. Lower is better\./);
  assert.match(report, /\| bug: The sign is wrong\. \| must \| 3 of 3 \| 2 of 3 \| 2 of 3 \|/);
  assert.match(report, /Review cost \$2\.00, matching cost \$0\.02\./);
  assert.match(report, /- low, documentation, `a\.ts:1`\. Other/);
});
