import assert from "node:assert/strict";
import { test } from "node:test";
import { alreadyReported, buildReview, commentBody, MARKER, parseHunks, place, withoutLineComments } from "../action/comments.ts";

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

const finding = (file: string, start: number, end: number, message = "Title: detail text.") => ({ file, start_line: start, end_line: end, message });

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

test("puts the opening sentence of a finding in bold and marks the comment", () => {
  assert.equal(commentBody(finding("a", 1, 1)), `**Title**\n\ndetail text.\n\n${MARKER}`);
  assert.equal(commentBody(finding("a", 1, 1, "No separator here")), `No separator here\n\n${MARKER}`);
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
    findings: [finding("src/a.ts", 11, 12), finding("src/a.ts", 42, 42), finding("src/a.ts", 100, 101, "Far away: not in the diff.")],
    fit: { verdict: "fits_with_concerns", summary: "It mostly belongs.", reasons: [{ point: "Adds a second cache.", source: "docs/design.md" }] },
    hunks: parseHunks(DIFF),
    existing: [{ path: "src/a.ts", line: 42, start_line: null, body: MARKER }],
    head: "abcdef0123456789", model: "vendor/model", minSeverity: "high",
  });
  assert.deepEqual(parts.comments.map((comment) => [comment.path, comment.start_line, comment.line]), [["src/a.ts", 11, 12]]);
  assert.match(parts.body, /Reviewed commit abcdef0 with vendor\/model\. Only findings of high severity are reported\./);
  assert.match(parts.body, /\*\*It fits, with concerns\.\*\* It mostly belongs\./);
  assert.match(parts.body, /- Adds a second cache\. \(docs\/design\.md\)/);
  assert.match(parts.body, /1 finding\(s\) are posted as comments/);
  assert.match(parts.body, /1 finding\(s\) were left out because an earlier review/);
  assert.match(parts.body, /`src\/a\.ts:100-101` Far away: not in the diff\./);
});

test("says so when there is nothing to report", () => {
  const parts = buildReview({ findings: [], fit: null, hunks: new Map(), existing: [], head: "a".repeat(40), model: "m", minSeverity: "low" });
  assert.deepEqual(parts.comments, []);
  assert.match(parts.body, /All findings are reported\./);
  assert.match(parts.body, /No findings\./);
  assert.doesNotMatch(parts.body, /belong in the project/);
});

test("can move every line comment into the summary", () => {
  const parts = buildReview({ findings: [finding("src/a.ts", 11, 12)], fit: null, hunks: parseHunks(DIFF), existing: [], head: "a".repeat(40), model: "m", minSeverity: "high" });
  const moved = withoutLineComments(parts);
  assert.deepEqual(moved.comments, []);
  assert.match(moved.body, /`src\/a\.ts:11-12` \*\*Title\*\* detail text\./);
  assert.equal(moved.body.split(MARKER).length, 2);
});
