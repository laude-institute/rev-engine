import assert from "node:assert/strict";
import { test } from "node:test";
import { fitPrompt, parseFit } from "../src/fit.ts";
import type { Candidate } from "../src/findings.ts";

test("accepts a well-formed fit assessment", () => {
  const fit = parseFit({
    verdict: "does_not_fit",
    summary: " The project is a parser and this adds a server. ",
    reasons: [{ point: "The README rules out network code.", source: "README.md" }, { point: "", source: "x" }, "junk"],
  }, "vendor/model");
  assert.deepEqual(fit, {
    verdict: "does_not_fit",
    summary: "The project is a parser and this adds a server.",
    reasons: [{ point: "The README rules out network code.", source: "README.md" }],
    model: "vendor/model",
  });
});

test("rejects a submission with no known verdict or no summary", () => {
  assert.equal(parseFit({ verdict: "maybe", summary: "x", reasons: [] }, "m"), null);
  assert.equal(parseFit({ verdict: "fits", summary: "  ", reasons: [] }, "m"), null);
  assert.deepEqual(parseFit({ verdict: "fits", summary: "Fine." }, "m")?.reasons, []);
  assert.deepEqual(parseFit({ verdict: "fits", summary: "Fine.", reasons: [{ point: "Reuses the queue.", source: "a.md", detail: "Same email type." }, { point: "Short.", source: "b.md" }] }, "m")?.reasons,
    [{ point: "Reuses the queue.", source: "a.md", detail: "Same email type." }, { point: "Short.", source: "b.md" }]);
});

test("gives the fit prompt the rules from base and the documents to read", () => {
  const prompt = fitPrompt(
    { nwo: "owner/repo", number: 7, title: "Add a thing", body: "" },
    new Map([["src/a.ts", [[1, 2]]]]), "diff --git a/src/a.ts b/src/a.ts", [{ path: "AGENTS.md", text: "Keep it small." }], ["docs/charter.md"],
    [{ file: "src/a.ts", startLine: 3, endLine: 5, severity: "high", title: "Wrong sign" }] as unknown as Candidate[], 9, 20,
  );
  assert.match(prompt, /- src\/a\.ts:3-5 \(high\) Wrong sign/);
  assert.match(fitPrompt({ nwo: "o/r", number: 1, title: "", body: "" }, new Map(), "", [], [], [], 1, 1), /reported no defects/);
  assert.match(prompt, /owner\/repo#7/);
  assert.match(prompt, /<project_file path="AGENTS\.md">\nKeep it small\./);
  assert.match(prompt, /- docs\/charter\.md/);
  assert.match(prompt, /20 turns and about 9 minutes/);
});

test("the fit prompt carries the maintainer's earlier fit answers, and is unchanged without them", () => {
  const prompt = (prior?: Parameters<typeof fitPrompt>[8]) => fitPrompt({ nwo: "o/r", number: 1, title: "T", body: "" }, new Map(), "", [], [], [], 1, 1, prior);
  const plain = prompt();
  assert.equal(prompt(null), plain);
  assert.equal(prompt({ entries: [], omitted: 0 }), plain);
  const answered = prompt({ entries: [], omitted: 0, fit: [{ round: 1, verdict: "fits", text: "The folder layout is intended.", source: "x" }] });
  assert.match(answered, /The maintainer's latest verdict stands, unless the change has moved since/);
  assert.match(answered, /<fit_answer round="1">\nThe maintainer's verdict: the change fits\.\n\nThe folder layout is intended\.\n<\/fit_answer>/);
});
