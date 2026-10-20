import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReview, type ReviewInput } from "../action/comments.ts";
import { applyVerdicts, parseVerdicts, type Candidate } from "../src/findings.ts";
import { parsePrior, priorDecisionsSection, priorDecisionsVerifierSection, repeatNote, type PriorDecisions } from "../src/prior.ts";
import { reviewerPrompt, submitVerdicts, submitVerdictsWithPrior, verifierPrompt } from "../src/prompts.ts";

const PRIOR: PriorDecisions = {
  entries: [
    { id: "P1", file: "src/a.ts", lines_hint: "3-5 at abcdef0", title: "No unsubscribe link.", decision: "wont_fix", reason: "Internal only.", round: 1, source: "x" },
    { id: "P2", file: "src/b.ts", title: "Spec not updated.", decision: "fixed", round: 1, source: "y" },
  ],
  omitted: 2,
};

const pr = { nwo: "o/r", number: 1, title: "T", body: "B" };
const changed = new Map<string, Array<[number, number]>>([["src/a.ts", [[1, 5]]]]);
const budget = { turns: 10, minutes: 5 };
const candidate = (id: string): Candidate => ({ id, seat: "s1", file: "src/a.ts", startLine: 1, endLine: 1, severity: "medium", kind: "defect", title: id, detail: "", confidence: 0.8 });

test("keeps well-formed earlier decisions and drops the rest", () => {
  const parsed = parsePrior({ entries: [PRIOR.entries[0], { id: "P9", title: "x", decision: "maybe" }, { title: "no id", decision: "fixed" }], omitted: 1 });
  assert.deepEqual(parsed?.entries.map((entry) => entry.id), ["P1"]);
  assert.equal(parsed?.omitted, 1);
  assert.equal(parsePrior({ entries: [] }), null);
  assert.equal(parsePrior("nope"), null);
});

test("the prompts are unchanged without earlier decisions", () => {
  assert.equal(reviewerPrompt(pr, changed, "diff", [], [], budget), reviewerPrompt(pr, changed, "diff", [], [], budget, undefined, null));
  assert.doesNotMatch(reviewerPrompt(pr, changed, "diff", [], [], budget), /earlier_decisions/);
  assert.equal(verifierPrompt(pr, changed, "diff", [candidate("a")]), verifierPrompt(pr, changed, "diff", [candidate("a")], null));
});

test("the prompts carry the earlier decisions when there are some", () => {
  const section = priorDecisionsSection(PRIOR);
  assert.match(section, /P1, src\/a\.ts \(was 3-5 at abcdef0\), round 1: No unsubscribe link\. Decision: won't fix\. Reason: Internal only\./);
  assert.match(section, /2 more decisions were left out/);
  assert.ok(reviewerPrompt(pr, changed, "diff", [], [], budget, undefined, PRIOR).includes(section));
  assert.match(verifierPrompt(pr, changed, "diff", [candidate("a")], PRIOR), /set repeat_of to that earlier id/);
});

test("only the verifier given earlier decisions must say whether a finding repeats one", () => {
  const items = (tool: typeof submitVerdicts) => (tool.function.parameters as { properties: { verdicts: { items: { required: string[] } } } }).properties.verdicts.items;
  assert.ok(!items(submitVerdicts).required.includes("repeat_of"));
  assert.ok(items(submitVerdictsWithPrior).required.includes("repeat_of"));
  assert.ok(items(submitVerdictsWithPrior).required.includes("exception_holds"));
});

test("drops a repeat of a decided finding unless the verifier says an exception holds", () => {
  const verdicts = parseVerdicts([
    { id: "a", verdict: "confirmed", duplicate_of: null, repeat_of: "P1", exception_holds: false },
    { id: "b", verdict: "confirmed", duplicate_of: null, repeat_of: "P2", exception_holds: true },
    { id: "c", verdict: "confirmed", duplicate_of: null, repeat_of: null, exception_holds: false },
    { id: "d", verdict: "confirmed", duplicate_of: "a" },
    { id: "e", verdict: "uncertain", duplicate_of: null, repeat_of: "P1", exception_holds: "yes" },
  ]);
  assert.equal(verdicts[0]!.repeatOf, "P1");
  assert.equal(verdicts[2]!.repeatOf, undefined);
  const kept = applyVerdicts(["a", "b", "c", "d", "e"].map(candidate), verdicts, false).map((item) => item.id);
  // d names a as its duplicate, but a was left out as a repeat, so d is kept.
  assert.deepEqual(kept, ["b", "c", "d"]);
});

test("the summary says how many findings were left out as already decided", () => {
  const input: ReviewInput = { findings: [], fit: null, hunks: new Map(), existing: [], head: "a".repeat(40), model: "m", minSeverity: "medium", maxComments: 10 };
  assert.doesNotMatch(buildReview(input).body, /already decided/);
  assert.match(buildReview({ ...input, decided: ["P2", "P5", "P2"] }).body, /3 findings were left out as already decided by the maintainer in an earlier round \(P2, P5\)\./);
});

test("a resolved finding may come back when the problem is still there, like a fixed one", () => {
  assert.match(priorDecisionsSection(PRIOR), /decided as fixed, partly fixed, or resolved without a stated reason, unless code at head shows the problem is still there/);
  assert.match(priorDecisionsSection(PRIOR), /decided as wrong, won't fix or deferred, unless the code at head changed/);
  assert.match(priorDecisionsVerifierSection(PRIOR), /fixed, partly fixed, or resolved without a stated reason: true only when the code at head shows the problem is still there/);
  assert.match(repeatNote({ ...PRIOR.entries[0]!, decision: "resolved" }), /problem is still there/);
  assert.match(repeatNote(PRIOR.entries[0]!), /^This is earlier finding P1 from round 1, decided as won't fix; the code has changed since/);
});
