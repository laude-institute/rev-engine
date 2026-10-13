import assert from "node:assert/strict";
import { test } from "node:test";
import { fitPrompt, parseFit } from "../src/fit.ts";

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
});

test("gives the fit prompt the rules from base and the documents to read", () => {
  const prompt = fitPrompt(
    { nwo: "owner/repo", number: 7, title: "Add a thing", body: "" },
    new Map([["src/a.ts", [[1, 2]]]]), "diff --git a/src/a.ts b/src/a.ts", [{ path: "AGENTS.md", text: "Keep it small." }], ["docs/charter.md"], 9, 20,
  );
  assert.match(prompt, /owner\/repo#7/);
  assert.match(prompt, /<project_file path="AGENTS\.md">\nKeep it small\./);
  assert.match(prompt, /- docs\/charter\.md/);
  assert.match(prompt, /20 turns and about 9 minutes/);
});
