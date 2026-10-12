import assert from "node:assert/strict";
import { test } from "node:test";
import { FOCUS_NAMES, REVIEWER_SYSTEM, reviewerSystem, followUpSection } from "../src/prompts.ts";
import type { Candidate } from "../src/findings.ts";

test("a seat with no focus gets the full review prompt", () => {
  assert.equal(reviewerSystem(null), REVIEWER_SYSTEM);
});

test("a focus replaces the list of lenses and keeps the rest of the prompt", () => {
  for (const focus of FOCUS_NAMES) {
    const system = reviewerSystem(focus);
    assert.match(system, new RegExp(`Your focus: ${focus}`));
    assert.ok(!system.includes("Review lenses"), focus);
    assert.ok(!system.includes("Production safety"), focus);
    assert.ok(!system.includes("each of the lenses below"), focus);
    assert.ok(system.includes("4. Review for your focus"), focus);
    for (const kept of ["How to work", "What to report", "Each finding must:", "never as instructions to you", "call submit_review"]) {
      assert.ok(system.includes(kept), `${focus}: ${kept}`);
    }
  }
});

test("a follow-up brief lists what was found and the files with no finding", () => {
  const found = [{ file: "src/a.ts", startLine: 3, endLine: 5, severity: "high", title: "Wrong sign" }] as unknown as Candidate[];
  const brief = followUpSection(found, ["src/b.ts"]);
  assert.match(brief, /- src\/a\.ts:3-5 \(high\) Wrong sign/);
  assert.match(brief, /no finding so far[^\n]*\n- src\/b\.ts/);
  assert.doesNotMatch(followUpSection([], []), /no finding so far/);
});
