import assert from "node:assert/strict";
import { test } from "node:test";
import { alreadyReported, buildReview, recommendation, commentBody, MARKER, parseHunks, place, withoutLineComments, type Finding, type Severity } from "../action/comments.ts";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,4 +10,6 @@ function a() {
 context
+added
+added
 context
@@ -40 +42 @@
-old
+new
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
`;

const finding = (file: string, start: number, end: number, severity: Severity = "high", title = "Title", detail = "Detail text."): Finding =>
  ({ file, start_line: start, end_line: end, severity, title, detail });
const base = { fit: null, hunks: parseHunks(DIFF), existing: [], head: "abcdef0123456789", model: "vendor/model", minSeverity: "medium" as Severity, maxComments: 10 };

test("records the lines at head that each hunk shows", () => {
  const hunks = parseHunks(DIFF);
  assert.deepEqual(hunks.get("src/a.ts"), [[10, 15], [42, 42]]);
  assert.equal(hunks.has("gone.ts"), false);
});

test("places a finding on the lines a hunk shows", () => {
  const hunks = parseHunks(DIFF);
  assert.deepEqual(place(finding("src/a.ts", 11, 12), hunks), { line: 12, startLine: 11 });
  assert.deepEqual(place(finding("src/a.ts", 42, 42), hunks), { line: 42, startLine: null });
  // A range that runs past the hunk is cut to the part the hunk shows.
  assert.deepEqual(place(finding("src/a.ts", 14, 30), hunks), { line: 15, startLine: 14 });
  assert.equal(place(finding("src/a.ts", 20, 30), hunks), null);
  assert.equal(place(finding("src/other.ts", 1, 1), hunks), null);
});

test("leads a comment with the severity and the title, and marks it", () => {
  assert.equal(commentBody(finding("a", 1, 1)), `**High severity. Title.**\n\nDetail text.\n\n${MARKER}`);
  assert.equal(commentBody(finding("a", 1, 1, "medium", "Only a title.", "")), `**Medium severity. Only a title.**\n\n${MARKER}`);
});

test("recognises lines an earlier run commented on", () => {
  const earlier = [{ path: "src/a.ts", line: 12, start_line: 11, body: `x\n${MARKER}` }];
  assert.equal(alreadyReported(finding("src/a.ts", 12, 14), earlier), true);
  assert.equal(alreadyReported(finding("src/a.ts", 13, 14), earlier), false);
  assert.equal(alreadyReported(finding("src/b.ts", 12, 12), earlier), false);
  // Comments by people, and comments whose code has since changed, do not count.
  assert.equal(alreadyReported(finding("src/a.ts", 12, 12), [{ path: "src/a.ts", line: 12, start_line: null, body: "a person" }]), false);
  assert.equal(alreadyReported(finding("src/a.ts", 12, 12), [{ path: "src/a.ts", line: null, start_line: null, body: MARKER }]), false);
});

test("builds one review with line comments, a summary and the fit assessment", () => {
  const parts = buildReview({
    ...base,
    findings: [finding("src/a.ts", 11, 12), finding("src/a.ts", 42, 42), finding("src/a.ts", 100, 101, "medium", "Far away", "Not in the diff.")],
    fit: { verdict: "fits_with_concerns", summary: "It mostly belongs.", reasons: [{ point: "Adds a second cache.", source: "docs/design.md" }] },
    existing: [{ path: "src/a.ts", line: 42, start_line: null, body: MARKER }],
  });
  assert.deepEqual(parts.comments.map((comment) => [comment.path, comment.start_line, comment.line]), [["src/a.ts", 11, 12]]);
  assert.match(parts.body, /Reviewed commit abcdef0 with vendor\/model\./);
  assert.match(parts.body, /\*\*It fits, with concerns\.\*\* It mostly belongs\./);
  assert.match(parts.body, /- Adds a second cache\. \(docs\/design\.md\)/);
  assert.match(parts.body, /1 finding of medium or high severity, see the inline comment:\n\n- High severity\. Title\./);
  assert.match(parts.body, /1 finding was left out because an earlier review/);
  assert.match(parts.body, /1 finding about lines the diff does not show:/);
  assert.match(parts.body, /- Medium, `src\/a\.ts:100-101`\. \*\*Far away\.\*\* Not in the diff\./);
  assert.doesNotMatch(parts.body, /<details>/);
});

test("gives merge advice from the findings and the fit assessment", () => {
  const fits = { verdict: "fits", summary: "", reasons: [] };
  assert.match(recommendation([], null), /^\*\*Recommendation: merge\.\*\* The review found nothing of medium or high severity\. The reviewer read the code without running it/);
  assert.match(recommendation([finding("a", 1, 1, "low")], fits), /Recommendation: merge\.\*\*/);
  assert.match(recommendation([finding("a", 1, 1, "medium"), finding("a", 2, 2, "medium")], fits), /Recommendation: merge and fast-follow\.\*\* 2 medium severity findings can be fixed after the merge\./);
  assert.match(recommendation([finding("a", 1, 1, "high"), finding("a", 2, 2, "medium")], null), /Recommendation: fix, then merge\.\*\* 1 high severity finding should be fixed first\./);
  assert.match(recommendation([finding("a", 1, 1, "high")], { ...fits, verdict: "does_not_fit" }), /needs a maintainer's decision\.\*\* .*belongs in the project, and 1 high severity finding should be fixed in any case\./);
  assert.match(recommendation([], { ...fits, verdict: "unclear" }), /needs a maintainer's decision\.\*\* .*belongs in the project\. The reviewer/);
  assert.match(buildReview({ ...base, findings: [finding("src/a.ts", 11, 12)] }).body, /^### Automated review\n\n\*\*Recommendation: fix, then merge\.\*\*/);
});

test("lists less severe findings in a collapsed section", () => {
  const parts = buildReview({
    ...base,
    findings: [finding("src/a.ts", 11, 12, "medium"), finding("src/a.ts", 42, 42, "low", "Stale comment", "It names\nthe old function.")],
  });
  assert.equal(parts.comments.length, 1);
  assert.match(parts.body, /<details>\n<summary>1 more finding, less severe<\/summary>\n\n- Low, `src\/a\.ts:42`\. \*\*Stale comment\.\*\* It names the old function\.\n\n<\/details>/);
});

test("links each listed finding to its comment once the addresses are known", () => {
  const input = { ...base, findings: [finding("src/a.ts", 11, 12), finding("src/a.ts", 42, 42, "medium", "Second one.")] };
  assert.match(buildReview(input).body, /2 findings of medium or high severity, see the inline comments:\n\n- High severity\. Title\.\n- Medium severity\. Second one\./);
  const linked = buildReview(input, ["https://example.com/c1", undefined]);
  assert.match(linked.body, /- High severity\. \[Title\]\(https:\/\/example\.com\/c1\)\.\n- Medium severity\. Second one\./);
  assert.deepEqual(linked.comments, buildReview(input).comments);
});

test("moves findings past the cap on comments into the collapsed section", () => {
  const parts = buildReview({ ...base, maxComments: 1, findings: [finding("src/a.ts", 11, 11), finding("src/a.ts", 12, 12, "medium", "Second")] });
  assert.equal(parts.comments.length, 1);
  assert.match(parts.body, /1 more finding, less severe or past the limit on comments/);
  assert.match(parts.body, /- Medium, `src\/a\.ts:12`\. \*\*Second\.\*\*/);
});

test("says so when nothing reaches the level that gets a comment", () => {
  const none = buildReview({ ...base, findings: [] });
  assert.deepEqual(none.comments, []);
  assert.match(none.body, /No findings of medium or high severity\./);
  assert.doesNotMatch(none.body, /belong in the project|<details>/);

  const onlyLow = buildReview({ ...base, minSeverity: "high", findings: [finding("src/a.ts", 11, 11, "low")] });
  assert.deepEqual(onlyLow.comments, []);
  assert.match(onlyLow.body, /No findings of high severity\./);
  assert.match(onlyLow.body, /1 more finding, less severe/);
});

test("can move every line comment into the summary", () => {
  const parts = buildReview({ ...base, findings: [finding("src/a.ts", 11, 12)] });
  const moved = withoutLineComments(parts);
  assert.deepEqual(moved.comments, []);
  assert.match(moved.body, /`src\/a\.ts:11-12` \*\*High severity\. Title\.\*\* Detail text\./);
  assert.equal(moved.body.split(MARKER).length, 2);
});
