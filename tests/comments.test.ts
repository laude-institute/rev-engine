import assert from "node:assert/strict";
import { test } from "node:test";
import { textSimilarity } from "../src/findings.ts";
import { buildReview, earlierComment, textSimilarity as actionSimilarity, recommendation, commentBody, MARKER, parseHunks, place, withoutLineComments, type Finding, type Severity } from "../action/comments.ts";

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

test("names the kind of a finding that is not a defect in the code", () => {
  assert.match(commentBody({ ...finding("a", 1, 1, "medium"), kind: "test" }), /^\*\*Medium severity, test coverage\. Title\.\*\*/);
  assert.match(commentBody({ ...finding("a", 1, 1, "medium"), kind: "defect" }), /^\*\*Medium severity\. Title\.\*\*/);
  const parts = buildReview({ ...base, findings: [{ ...finding("src/a.ts", 42, 42, "low"), kind: "documentation" }] });
  assert.match(parts.body, /- Low severity, documentation, `src\/a\.ts:42`\./);
});

test("an earlier comment counts only on overlapping lines, in nearly the same words, in an open thread", () => {
  const raised = finding("src/a.ts", 11, 12, "medium", "The cache is never cleared", "Entries stay after the user logs out.");
  const earlier = [{ id: 7, path: "src/a.ts", line: 12, start_line: 11, body: commentBody(raised), html_url: "https://example.com/c7" }];
  assert.equal(earlierComment(raised, earlier)?.id, 7);
  assert.equal(earlierComment({ ...raised, start_line: 13, end_line: 14 }, earlier), null, "lines that do not overlap");
  assert.equal(earlierComment({ ...raised, file: "src/b.ts" }, earlier), null, "another file");
  assert.equal(earlierComment(finding("src/a.ts", 11, 12, "medium", "A retry loop never ends", "It retries forever on a 404."), earlier), null, "another problem on the same lines");
  assert.equal(earlierComment(raised, earlier, new Set([7])), null, "a resolved or decided thread is left to the verifier");
  // Comments by people, and comments whose code has since changed, do not count.
  assert.equal(earlierComment(raised, [{ path: "src/a.ts", line: 12, start_line: 11, body: "The cache is never cleared. Entries stay after the user logs out." }]), null);
  assert.equal(earlierComment(raised, [{ ...earlier[0]!, line: null }]), null);
});

test("a new problem on lines an earlier comment covered is posted, and a repeat is listed with a link", () => {
  const old = finding("src/a.ts", 11, 12, "medium", "A failure to load thread comments drops mention emails too", "When the thread comments fail to load, the mention emails for the reply are skipped as well.");
  const fresh = finding("src/a.ts", 11, 12, "medium", "One malformed mention anywhere in a thread drops every later email in that thread", "A single mention that does not parse throws, and every later reply in the thread sends no email.");
  const resolved = { id: 1, path: "src/a.ts", line: 12, start_line: 11, body: commentBody(old), html_url: "https://example.com/c1" };
  let parts = buildReview({ ...base, findings: [fresh], existing: [resolved], settled: new Set([1]) });
  assert.equal(parts.comments.length, 1, "a different problem in a resolved thread is posted");
  parts = buildReview({ ...base, findings: [fresh], existing: [resolved] });
  assert.equal(parts.comments.length, 1, "a different problem is posted even when the thread is open");

  const repeat = { ...old, detail: "If loading the thread comments fails, the reply's mention emails are skipped as well." };
  parts = buildReview({ ...base, findings: [repeat], existing: [resolved] });
  assert.equal(parts.comments.length, 0);
  assert.match(parts.body, /<summary>1 finding was not commented again because an earlier review's open comment on the same lines already raises it<\/summary>/);
  assert.match(parts.body, /A failure to load thread comments drops mention emails too\.\*\*.* Already raised in \[this comment\]\(https:\/\/example\.com\/c1\)\./);
});

test("the two copies of the word similarity agree", () => {
  const pairs = [
    ["The cache is never cleared", "Cache never cleared after logout"],
    ["A failure to load thread comments drops mention emails too", "One malformed mention anywhere in a thread drops every later email in that thread"],
    ["", "anything"],
    ["same_words here", "same_words here"],
  ] as const;
  for (const [a, b] of pairs) assert.equal(actionSimilarity(a, b), textSimilarity(a, b));
});

test("builds one review with line comments, a summary and the fit assessment", () => {
  const parts = buildReview({
    ...base,
    findings: [finding("src/a.ts", 11, 12), finding("src/a.ts", 42, 42), finding("src/a.ts", 100, 101, "medium", "Far away", "Not in the diff.")],
    fit: { verdict: "fits_with_concerns", summary: "It mostly belongs.", reasons: [{ point: "Adds a second cache.", source: "docs/design.md" }] },
    existing: [{ path: "src/a.ts", line: 42, start_line: null, body: commentBody(finding("src/a.ts", 42, 42)) }],
  });
  assert.deepEqual(parts.comments.map((comment) => [comment.path, comment.start_line, comment.line]), [["src/a.ts", 11, 12]]);
  assert.match(parts.body, /Reviewed commit abcdef0 with vendor\/model, by reading the code\. It did not run the code or look at the checks\./);
  assert.match(parts.body, /\*\*It fits, with concerns\.\*\* It mostly belongs\./);
  assert.match(parts.body, /\*\*It fits, with concerns\.\*\* It mostly belongs\.\n\n<details>\n<summary>1 reason with sources<\/summary>\n\n- Adds a second cache\. \(docs\/design\.md\)/);
  assert.match(parts.body, /1 finding of medium or high severity, see the inline comment:\n\n- High severity\. Title\./);
  assert.match(parts.body, /1 finding was not commented again because an earlier review's open comment/);
  assert.match(parts.body, /1 finding about lines the diff does not show:\n\n- Medium severity\. Far away\. `src\/a\.ts:100-101`\n\n<details>\n<summary>Details of this finding<\/summary>/);
  assert.match(parts.body, /- Medium severity, `src\/a\.ts:100-101`\. \*\*Far away\.\*\* Not in the diff\./);
  assert.doesNotMatch(parts.body, /more finding/);
});

test("gives merge advice from the findings and the fit assessment", () => {
  const fits = { verdict: "fits", summary: "", reasons: [] };
  assert.match(recommendation([], null), /^\*\*Recommendation: merge\.\*\* The review found nothing of medium or high severity\.$/);
  assert.match(recommendation([finding("a", 1, 1, "low")], fits), /Recommendation: merge\.\*\*/);
  assert.match(recommendation([finding("a", 1, 1, "medium"), finding("a", 2, 2, "medium")], fits), /Recommendation: merge and fast-follow\.\*\* 2 medium severity findings can be fixed after the merge\./);
  assert.match(recommendation([finding("a", 1, 1, "high"), finding("a", 2, 2, "medium")], null), /Recommendation: fix, then merge\.\*\* 1 high severity finding should be fixed first\./);
  assert.match(recommendation([finding("a", 1, 1, "high")], { ...fits, verdict: "does_not_fit" }), /needs a maintainer's decision\.\*\* The change may not belong in the project, and 1 high severity finding should be fixed in any case\.$/);
  assert.match(recommendation([], { ...fits, verdict: "unclear" }), /needs a maintainer's decision\.\*\* The project states too little to tell whether the change belongs\.$/);
  assert.match(buildReview({ ...base, findings: [finding("src/a.ts", 11, 12)] }).body, /^### Automated review\n\n\*\*Recommendation: fix, then merge\.\*\*/);
});

test("lists less severe findings in a collapsed section", () => {
  const parts = buildReview({
    ...base,
    findings: [finding("src/a.ts", 11, 12, "medium"), finding("src/a.ts", 42, 42, "low", "Stale comment", "It names\nthe old function.")],
  });
  assert.equal(parts.comments.length, 1);
  assert.match(parts.body, /<details>\n<summary>1 more finding, less severe<\/summary>\n\n- Low severity, `src\/a\.ts:42`\. \*\*Stale comment\.\*\* It names the old function\.\n\n<\/details>/);
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
  assert.match(parts.body, /- Medium severity, `src\/a\.ts:12`\. \*\*Second\.\*\*/);
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

test("the fit section keeps two sentences of the summary in view and collapses the rest", () => {
  const parts = buildReview({ ...base, findings: [], fit: {
    verdict: "fits", summary: "It extends an existing feature. It reuses the queue. It also adds a helper folder, which is allowed.",
    reasons: [{ point: "Reuses the mention queue.", detail: "The spec lists the same email type.", source: "specs/lander.spec.md" }],
  } });
  assert.match(parts.body, /\*\*It fits the project\.\*\* It extends an existing feature\. It reuses the queue\.\n\n<details>\n<summary>1 reason with sources<\/summary>\n\nIt also adds a helper folder, which is allowed\.\n\n- Reuses the mention queue\. The spec lists the same email type\. \(specs\/lander\.spec\.md\)/);
  const dotted = buildReview({ ...base, findings: [], fit: { verdict: "fits", summary: "It rewrites vibes/AGENTS.md to approve its own layout. It fits.", reasons: [] } });
  assert.match(dotted.body, /\*\* It rewrites vibes\/AGENTS\.md to approve its own layout\. It fits\.\n/);
  const bare = buildReview({ ...base, findings: [], fit: { verdict: "fits", summary: "A bug fix. It fits.", reasons: [] } });
  assert.doesNotMatch(bare.body, /<details>/);
});
