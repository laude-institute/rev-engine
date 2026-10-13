import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import type { Finding } from "../action/comments.ts";
import { adviceLabel, parseCase, renderReport, scoreCase, totals, type EvalCase, type RunResult } from "../evals/lib.ts";

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
