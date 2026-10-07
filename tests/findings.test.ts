import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyVerdicts,
  countLines,
  dedupe,
  normalizeCandidates,
  parseDiff,
  parseVerdicts,
  rank,
  toOutput,
  type Candidate,
} from "../src/findings.ts";

const DIFF = `diff --git a/src/pool.ts b/src/pool.ts
index 1111111..2222222 100644
--- a/src/pool.ts
+++ b/src/pool.ts
@@ -10,4 +10,6 @@ export class Pool {
 context
+added one
+added two
 context
-removed
+++ looks like a header
 context
@@ -40,2 +42,3 @@
 context
+tail
diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-gone
-gone
`;

function candidate(overrides: Partial<Candidate>): Candidate {
  return {
    id: "s1-01", seat: "s1", file: "src/pool.ts", startLine: 10, endLine: 12,
    severity: "medium", title: "Connections are read without the mutex", detail: "", confidence: 0.5,
    ...overrides,
  };
}

test("parseDiff reports added line ranges at head and skips deleted files", () => {
  const changed = parseDiff(DIFF);
  assert.deepEqual([...changed.keys()], ["src/pool.ts"]);
  assert.deepEqual(changed.get("src/pool.ts"), [[11, 12], [14, 14], [43, 43]]);
});

test("countLines ignores a trailing newline", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a\nb\n"), 2);
  assert.equal(countLines("a\nb"), 2);
});

test("normalizeCandidates fixes paths, clamps lines and drops unreadable files", async () => {
  const logs: string[] = [];
  const files: Record<string, string> = { "src/pool.ts": "1\n2\n3\n4\n5\n" };
  const result = await normalizeCandidates([
    { file: "/work/repo/src/pool.ts", start_line: 4, end_line: 99, severity: "high", title: "T1", detail: "D1", confidence: 2 },
    { file: "b/src/pool.ts", start_line: 0, end_line: null, severity: "odd", title: "T2", detail: "D2" },
    { file: "src/missing.ts", start_line: 1, end_line: 1, title: "T3", detail: "D3" },
    { file: "../etc/passwd", start_line: 1, end_line: 1, title: "T4", detail: "D4" },
    { file: "src/pool.ts", start_line: 3, end_line: 2, title: "", detail: "" },
    "not an object",
  ], {
    seat: "s1",
    repoDir: "/work/repo",
    changed: new Map([["src/pool.ts", [[2, 3]]]]),
    headFile: async (path) => files[path] ?? null,
    log: (message) => logs.push(message),
  });
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map(({ id, file, startLine, endLine, severity, confidence }) => ({ id, file, startLine, endLine, severity, confidence })),
    [
      { id: "s1-01", file: "src/pool.ts", startLine: 4, endLine: 5, severity: "high", confidence: 1 },
      { id: "s1-02", file: "src/pool.ts", startLine: 2, endLine: 2, severity: "medium", confidence: 0.5 },
    ],
  );
  assert.equal(logs.length, 2);
});

test("normalizeCandidates returns nothing for a submission that is not a list", async () => {
  const context = { seat: "s1", repoDir: "/r", changed: new Map(), headFile: async () => "x\n", log: () => {} };
  assert.deepEqual(await normalizeCandidates(undefined, context), []);
  assert.deepEqual(await normalizeCandidates({ findings: [] }, context), []);
});

test("dedupe merges near-identical findings on nearby lines and keeps the stronger one", () => {
  const detail = "The conns map is read in acquire without holding the mutex so concurrent callers race";
  const kept = dedupe([
    candidate({ id: "s1-01", detail, severity: "low" }),
    candidate({ id: "s2-01", seat: "s2", startLine: 13, endLine: 14, detail: `${detail} and lose writes`, severity: "high" }),
    candidate({ id: "s1-02", title: "Timeout is never cleared", detail: "The timer keeps the process alive after release" }),
    candidate({ id: "s2-02", file: "src/other.ts", detail }),
    candidate({ id: "s2-03", startLine: 200, endLine: 201, detail }),
  ]);
  assert.deepEqual(kept.map((item) => item.id), ["s2-01", "s1-02", "s2-02", "s2-03"]);
});

test("applyVerdicts drops rejected findings and duplicates of surviving ones", () => {
  const candidates = ["a", "b", "c", "d", "e", "f"].map((id) => candidate({ id }));
  const verdicts = parseVerdicts([
    { id: "a", verdict: "confirmed", duplicate_of: null },
    { id: "b", verdict: "rejected", duplicate_of: null },
    { id: "c", verdict: "confirmed", duplicate_of: "a" },
    { id: "d", verdict: "confirmed", duplicate_of: "b" },
    { id: "e", verdict: "uncertain", duplicate_of: "" },
    { id: "zzz", verdict: "confirmed" },
    { id: "f", verdict: "nonsense" },
  ]);
  assert.deepEqual(applyVerdicts(candidates, verdicts, false).map((item) => item.id), ["a", "d", "e", "f"]);
  assert.deepEqual(applyVerdicts(candidates, verdicts, true).map((item) => item.id), ["a", "d"]);
});

test("applyVerdicts keeps one of two findings that name each other as duplicates", () => {
  const candidates = [candidate({ id: "a" }), candidate({ id: "b" })];
  const verdicts = parseVerdicts([
    { id: "a", verdict: "confirmed", duplicate_of: "b" },
    { id: "b", verdict: "confirmed", duplicate_of: "a" },
  ]);
  assert.deepEqual(applyVerdicts(candidates, verdicts, false).map((item) => item.id), ["a"]);
});

test("rank orders by severity then confidence and applies the cap", () => {
  const ranked = rank([
    candidate({ id: "low", severity: "low", confidence: 0.9 }),
    candidate({ id: "high", severity: "high", confidence: 0.2 }),
    candidate({ id: "medium-sure", severity: "medium", confidence: 0.8 }),
    candidate({ id: "medium-unsure", severity: "medium", confidence: 0.3 }),
  ], 3);
  assert.deepEqual(ranked.map((item) => item.id), ["high", "medium-sure", "medium-unsure"]);
});

test("toOutput joins the title and detail into one message", () => {
  assert.deepEqual(toOutput(candidate({ title: "Race in acquire.", detail: "Two callers can take the same connection." }), "me"), {
    file: "src/pool.ts", start_line: 10, end_line: 12,
    message: "Race in acquire: Two callers can take the same connection.", producer: "me",
  });
  assert.equal(toOutput(candidate({ title: "Only a title", detail: "" }), "me").message, "Only a title");
});
