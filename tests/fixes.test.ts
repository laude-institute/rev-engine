import assert from "node:assert/strict";
import { test } from "node:test";
import type { Workspace } from "../src/tools.ts";
import type { Candidate } from "../src/findings.ts";
import { fixPrompt, MAX_FIX_LINES, parseFixes, proposeFixes } from "../src/fixes.ts";

const finding = (change: Partial<Candidate> = {}): Candidate => ({ id: "s1-01", seat: "s1", file: "src/a.ts", startLine: 12, endLine: 13, severity: "high", kind: "defect", title: "Off-by-one in the loop bound.", detail: "The loop reads one element past the end.", confidence: 0.9, ...change });
const FILE = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
const head = async (path: string) => (path === "src/a.ts" ? FILE : null);

async function parse(fixes: unknown[], findings: Candidate[] = [finding()]) {
  const log: string[] = [];
  return { fixes: await parseFixes({ fixes }, findings, head, (message) => log.push(message)), log };
}

test("keeps a fix on its finding's lines, in the order of the findings", async () => {
  const two = [finding(), finding({ title: "Other.", startLine: 5, endLine: 5 })];
  const { fixes } = await parse([{ id: "F2", start_line: 5, end_line: 5, replacement: "line five\r\n" }, { id: "F1", start_line: 12, end_line: 13, replacement: "  one\n  two\n  three" }], two);
  assert.deepEqual(fixes, [{ startLine: 12, endLine: 13, replacement: "  one\n  two\n  three" }, { startLine: 5, endLine: 5, replacement: "line five" }]);
  assert.deepEqual((await parse([{ id: "F1", start_line: 13, end_line: 13, replacement: "" }])).fixes, [{ startLine: 13, endLine: 13, replacement: "" }], "an empty text removes the lines");
  assert.deepEqual((await parse([])).fixes, [null], "a finding without a fix is the normal case");
});

test("drops a fix that cannot be applied safely, and says why", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ id: "F1", start_line: 13, end_line: 12, replacement: "x" }, /not usable/],
    [{ id: "F1", start_line: 12, end_line: 13 }, /not usable/],
    [{ id: "F1", start_line: 9, end_line: 9 + MAX_FIX_LINES, replacement: "x" }, /more than 10 lines/],
    [{ id: "F1", start_line: 1, end_line: 2, replacement: "x" }, /away from the finding/],
    [{ id: "F1", start_line: 12, end_line: 17, replacement: "x" }, /away from the finding/],
    [{ id: "F1", start_line: 12, end_line: 13, replacement: "x\n".repeat(16) }, /too long/],
    [{ id: "F1", start_line: 12, end_line: 13, replacement: "line 12\nline 13\n" }, /changes nothing/],
  ];
  for (const [fix, why] of cases) {
    const { fixes, log } = await parse([fix]);
    assert.deepEqual(fixes, [null], JSON.stringify(fix));
    assert.match(log.join("\n"), why);
  }
  const last = await parse([{ id: "F1", start_line: 20, end_line: 21, replacement: "x" }], [finding({ startLine: 20, endLine: 20 })]);
  assert.deepEqual(last.fixes, [null]);
  assert.match(last.log.join("\n"), /past the end of the file/);
  assert.deepEqual((await parse([{ id: "F9", start_line: 12, end_line: 12, replacement: "x" }, { id: "s1-01", start_line: 12, end_line: 12, replacement: "x" }, "junk"])).fixes, [null], "a fix that names no finding");
  const twice = await parse([{ id: "F1", start_line: 12, end_line: 12, replacement: "first" }, { id: "F1", start_line: 13, end_line: 13, replacement: "second" }]);
  assert.equal(twice.fixes[0]?.replacement, "first", "one fix for a finding");
});

test("gives the fix prompt each finding by its id", () => {
  const prompt = fixPrompt({ nwo: "owner/repo", number: 7, title: "Add a thing", body: "" }, [finding(), finding({ file: "src/b.ts", startLine: 3, endLine: 3, title: "Second." })], 4, 15);
  assert.match(prompt, /owner\/repo#7/);
  assert.match(prompt, /<finding id="F1" file="src\/a\.ts" lines="12-13" severity="high" kind="defect">\nOff-by-one in the loop bound\.\nThe loop reads one element past the end\./);
  assert.match(prompt, /<finding id="F2" file="src\/b\.ts" lines="3-3"/);
  assert.match(prompt, /15 turns and about 4 minutes/);
});

test("proposeFixes skips empty findings and contains failures", async () => {
  let calls = 0;
  const logs: string[] = [];
  const options = {
    chat: async () => { calls++; throw new Error("service unavailable"); }, model: "test/model",
    pr: { nwo: "owner/repo", number: 1, title: "Change", body: "" }, findings: [] as Candidate[],
    workspace: { headFile: head } as unknown as Workspace, deadline: Date.now() + 10_000, maxTurns: 40,
    log: (message: string) => logs.push(message),
  };
  assert.deepEqual(await proposeFixes(options), []);
  assert.equal(calls, 0);
  assert.deepEqual(await proposeFixes({ ...options, findings: [finding(), finding()] }), [null, null]);
  assert.ok(logs.some((line) => line.includes("fixes (test/model) failed")));
});

test("proposeFixes caps turns and preserves finding order", async () => {
  const fixes = await proposeFixes({
    chat: async (request) => {
      assert.match(String(request.messages[1]?.content), /15 turns/);
      return { role: "assistant", tool_calls: [{ id: "fix", type: "function", function: { name: "submit_fixes", arguments: JSON.stringify({ fixes: [{ id: "F2", start_line: 5, end_line: 5, replacement: "changed" }] }) } }] };
    }, model: "test/model", pr: { nwo: "owner/repo", number: 1, title: "Change", body: "" },
    findings: [finding(), finding({ startLine: 5, endLine: 5 })], workspace: { headFile: head } as unknown as Workspace,
    deadline: Date.now() + 10_000, maxTurns: 40, log: () => {},
  });
  assert.deepEqual(fixes, [null, { startLine: 5, endLine: 5, replacement: "changed" }]);
});
