import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chunk, chunkContext, chunkSymbols, findMentions, splitDiff, units } from "../experiments/prototypes/swarm/chunks.ts";
import { SWARM_SYSTEM, SWARM_VERIFIER_SYSTEM, submitSwarmReview } from "../experiments/prototypes/swarm/prompts.ts";
import { cleanGroups, representative } from "../experiments/prototypes/swarm/merge.ts";
import { rankBySupport, swarmReview, swarmSettings, tally } from "../experiments/prototypes/swarm/review.ts";
import type { Candidate } from "../src/findings.ts";
import { loadConfig } from "../src/config.ts";
import { ModelError, type Chat, type ChatRequest } from "../src/llm.ts";

const DIFF = `diff --git a/src/pool.ts b/src/pool.ts
index 1111111..2222222 100644
--- a/src/pool.ts
+++ b/src/pool.ts
@@ -1,3 +1,4 @@
 export class Pool {
-  function acquire(timeout) {
+  function acquire(timeout, retries) {
+    const MAX_WAIT = 10;
 }
@@ -40,2 +41,3 @@
 context
+tail
diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,1 +1,1 @@
-old
+new
diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-gone
`;

test("splits a diff into files and hunks at head, leaving out deleted files", () => {
  const files = splitDiff(DIFF);
  assert.deepEqual(files.map((file) => file.path), ["src/pool.ts", "package-lock.json"]);
  const [first, second] = files[0]!.hunks;
  assert.deepEqual([first!.start, first!.end, first!.size], [1, 4, 3]);
  assert.deepEqual([second!.start, second!.end, second!.size], [41, 42, 1]);
  assert.ok(first!.text.startsWith("@@ -1,3 +1,4 @@"));
});

test("groups nearby hunks into units, skips generated files, and packs units into chunks", () => {
  const all = units(splitDiff(DIFF));
  assert.equal(all.length, 2, "hunks 37 lines apart are separate units; the lockfile is skipped");
  assert.equal(chunk(all, 10).length, 1, "a small change is one chunk");
  const many = Array.from({ length: 30 }, (_, index) => ({ path: `f${index}.ts`, hunks: [], size: 100 }));
  assert.equal(chunk(many, 10).length, 10, "a large change gets larger chunks, not more of them");
});

test("finds the names a chunk defines or changes", () => {
  const [only] = chunk(units(splitDiff(DIFF)), 10);
  assert.deepEqual(chunkSymbols(only!), ["acquire", "MAX_WAIT"]);
});

test("finds mentions with git grep and shows the chunk's context without its own lines", async () => {
  const repo = mkdtempSync(join(tmpdir(), "swarm-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  git("init", "-q");
  execFileSync("mkdir", ["-p", join(repo, "src")]);
  writeFileSync(join(repo, "src/pool.ts"), "export class Pool {\n  function acquire(timeout, retries) {\n    const MAX_WAIT = 10;\n}\n");
  writeFileSync(join(repo, "src/use.ts"), "pool.acquire(5);\nconst reacquired = 1;\n");
  git("add", ".");
  const mentions = await findMentions(repo, ["acquire", "MAX_WAIT", "bad name"]);
  assert.deepEqual(mentions.get("acquire")!.map((mention) => `${mention.path}:${mention.line}`), ["src/pool.ts:2", "src/use.ts:1"]);
  const [only] = chunk(units(splitDiff(DIFF)), 10);
  const context = await chunkContext(only!, async (path) => path === "src/pool.ts" ? "export class Pool {\n  function acquire(timeout, retries) {\n" : null, mentions);
  assert.match(context, /2:   function acquire\(timeout, retries\)/);
  assert.match(context, /src\/use\.ts:1: pool\.acquire\(5\);/);
  assert.doesNotMatch(context, /src\/pool\.ts:2:/, "the chunk's own lines are not listed as mentions");
});

test("tallies verifier votes by majority", () => {
  const verdicts = tally(["a", "b", "c", "d"], [
    [{ id: "a", verdict: "rejected", duplicateOf: null }, { id: "b", verdict: "confirmed", duplicateOf: "a" }, { id: "c", verdict: "rejected", duplicateOf: null }],
    [{ id: "a", verdict: "rejected", duplicateOf: null }, { id: "b", verdict: "uncertain", duplicateOf: "a" }],
    [{ id: "a", verdict: "confirmed", duplicateOf: null }, { id: "b", verdict: "confirmed", duplicateOf: null }, { id: "c", verdict: "confirmed", duplicateOf: null }],
  ]);
  assert.deepEqual(verdicts, [
    { id: "a", verdict: "rejected", duplicateOf: null },
    { id: "b", verdict: "confirmed", duplicateOf: "a" },
    { id: "c", verdict: "confirmed", duplicateOf: null },
    { id: "d", verdict: "uncertain", duplicateOf: null },
  ]);
});

test("reads and checks the swarm settings", () => {
  assert.deepEqual(swarmSettings({}).split, "task");
  assert.deepEqual(swarmSettings({ RB_CONFIG_SWARM_TASKS: "callers, tests" }).tasks, ["callers", "tests"]);
  assert.throws(() => swarmSettings({ RB_CONFIG_SWARM_TASKS: "vibes" }), /unknown task/);
  assert.throws(() => swarmSettings({ RB_CONFIG_SWARM_VOTES: "9" }), /RB_CONFIG_SWARM_VOTES/);
  assert.doesNotMatch(SWARM_SYSTEM, /ten or more findings/);
  assert.match(SWARM_VERIFIER_SYSTEM, /outside specification or standard says, and nothing in the checkout shows it, mark the finding uncertain/);
  assert.ok((submitSwarmReview.function.parameters.required as string[]).includes("checked"));
});

test("runs the whole swarm end to end with a stand-in model", async () => {
  const repo = mkdtempSync(join(tmpdir(), "swarm-run-"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("mkdir", ["-p", join(repo, "src")]);
  writeFileSync(join(repo, "src/pool.ts"), `export class Pool {\n  function acquire(timeout, retries) {\n    const MAX_WAIT = 10;\n}\n${"context\n".repeat(37)}tail\n`);
  execFileSync("git", ["-C", repo, "add", "."]);
  const diffPath = join(repo, "..", `${repo.split("/").at(-1)}.patch`);
  writeFileSync(diffPath, DIFF);
  const config = loadConfig({
    RB_NWO: "owner/repo", RB_PR_NUMBER: "1", RB_BASE: "a".repeat(40), RB_HEAD: "b".repeat(40), RB_OUT: join(repo, "out", "findings.json"),
    OPENROUTER_API_KEY: "key", RB_REPO: repo, RB_DIFF: diffPath, RB_PR_JSON: join(repo, "missing.json"), RB_CONFIG_SWARM: "on",
  });
  const requests: ChatRequest[] = [];
  const chat: Chat = async (request) => {
    requests.push(request);
    const name = request.tools.at(-1)!.function.name;
    const args = name === "submit_verdicts"
      ? { verdicts: [{ id: "f1", verdict: "confirmed", reason: "seen", duplicate_of: null }] }
      : { checked: ["acquire"], findings: [{ file: "src/pool.ts", start_line: 2, end_line: 2, severity: "medium", kind: "defect", title: "retries is never used", detail: "The new retries parameter is ignored.", confidence: 0.8 }] };
    return { role: "assistant", tool_calls: [{ id: "1", type: "function", function: { name, arguments: JSON.stringify(args) } }] };
  };
  mkdirSync(join(repo, "out"));
  const outcome = await swarmReview(config, chat, () => {});
  const reviewers = requests.filter((request) => request.tools.at(-1)!.function.name === "submit_review");
  assert.equal(reviewers.length, 4 + 5, "four chunk tasks for the one chunk, and five global passes");
  assert.equal(requests.length - reviewers.length, 3, "three verifiers vote on the one batch");
  assert.equal(outcome.proposed, 9);
  assert.equal(outcome.findings.length, 1, "nine copies of one finding merge into one");
  assert.ok(outcome.verified);

  // The trace accounts for every proposal, every vote and the final list.
  const trace = JSON.parse(readFileSync(join(repo, "out", "swarm.json"), "utf8"));
  assert.equal(trace.agents.length, 9);
  assert.ok(trace.agents.every((agent: { status: string; checked: string[] }) => agent.status === "ok" && agent.checked[0] === "acquire"));
  assert.equal(trace.proposals.length, 9);
  assert.equal(trace.proposals.filter((proposal: { mergedInto: string | null }) => proposal.mergedInto).length, 8);
  assert.ok(trace.proposals.every((proposal: { findingId: string }) => proposal.findingId === "f1"));
  assert.equal(trace.verification[0].ballots.length, 3);
  assert.equal(trace.verification[0].ballots[0].reason, "seen");
  assert.equal(trace.final[0].from.length, 9);
  assert.deepEqual(trace.chunks[0].symbols, ["acquire", "MAX_WAIT"]);
});

async function swarmFixture(env: Record<string, string> = {}) {
  const repo = mkdtempSync(join(tmpdir(), "swarm-flaky-"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, "out"));
  writeFileSync(join(repo, "src/pool.ts"), `export class Pool {\n  function acquire(timeout, retries) {\n    const MAX_WAIT = 10;\n}\n${"context\n".repeat(37)}tail\n`);
  execFileSync("git", ["-C", repo, "add", "."]);
  const diffPath = join(repo, "out", "diff.patch");
  writeFileSync(diffPath, DIFF);
  const config = loadConfig({
    RB_NWO: "owner/repo", RB_PR_NUMBER: "1", RB_BASE: "a".repeat(40), RB_HEAD: "b".repeat(40), RB_OUT: join(repo, "out", "findings.json"),
    OPENROUTER_API_KEY: "key", RB_REPO: repo, RB_DIFF: diffPath, RB_PR_JSON: join(repo, "missing.json"), RB_CONFIG_SWARM: "on", ...env,
  });
  const trace = () => JSON.parse(readFileSync(join(repo, "out", "swarm.json"), "utf8"));
  return { config, trace };
}

function submitting(request: ChatRequest) {
  const name = request.tools.at(-1)!.function.name;
  const args = name === "submit_verdicts"
    ? { verdicts: [{ id: "f1", verdict: "confirmed", reason: "seen", duplicate_of: null }] }
    : { checked: [], findings: [{ file: "src/pool.ts", start_line: 2, end_line: 2, severity: "medium", kind: "defect", title: "retries is never used", detail: "Ignored.", confidence: 0.8 }] };
  return { role: "assistant" as const, tool_calls: [{ id: "1", type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] };
}

test("runs a failed agent once more in a new conversation, and records both attempts", async () => {
  const { config, trace } = await swarmFixture();
  const failures = new Map<string, number>();
  const chat: Chat = async (request) => {
    const caller = request.caller ?? "";
    // The logic agent is refused twice (both attempts), the callers agent once.
    const limit = caller.startsWith("c1/logic") ? 2 : caller.startsWith("c1/callers") ? 1 : 0;
    const seen = failures.get(caller.split("#")[0]!) ?? 0;
    if (seen < limit) {
      failures.set(caller.split("#")[0]!, seen + 1);
      throw new ModelError(400, "refused");
    }
    return submitting(request);
  };
  const outcome = await swarmReview(config, chat, () => {});
  assert.equal(outcome.findings.length, 1);
  const agents = trace().agents as Array<{ caller: string; status: string; attempts: number; errors: string[] }>;
  const callers = agents.find((agent) => agent.caller === "c1/callers")!;
  assert.deepEqual([callers.status, callers.attempts, callers.errors.length], ["ok", 2, 1]);
  const logic = agents.find((agent) => agent.caller === "c1/logic")!;
  assert.deepEqual([logic.status, logic.attempts, logic.errors.length], ["failed", 2, 2]);
});

test("fails the first attempt when most agents fail, so the benchmark retries, and keeps a later attempt", async () => {
  const flaky: Chat = async (request) => {
    if ((request.caller ?? "").startsWith("global/")) throw new ModelError(400, "refused");
    return submitting(request);
  };
  const first = await swarmFixture();
  await assert.rejects(swarmReview(first.config, flaky, () => {}), /only 4 of 9 swarm agents completed/);
  assert.equal(first.trace().agents.length, 9, "the trace is written even when the review fails");
  const second = await swarmFixture({ RB_ATTEMPT: "2" });
  const outcome = await swarmReview(second.config, flaky, () => {});
  assert.equal(outcome.findings.length, 1);
});

test("skips agents whose turn comes too late", async () => {
  const { config, trace } = await swarmFixture({ RB_CONFIG_TIME_BUDGET: "60" });
  await assert.rejects(swarmReview(config, async (request) => submitting(request), () => {}), /no swarm agent completed/);
  assert.ok((trace().agents as Array<{ status: string }>).every((agent) => agent.status === "skipped"));
});

function finding(id: string, startLine: number, overrides: Partial<Candidate> = {}): Candidate {
  return { id, seat: "c1/logic", file: "src/pool.ts", startLine, endLine: startLine, severity: "low", kind: "defect", title: id, detail: id, confidence: 0.5, ...overrides };
}

test("cleans the model's groups: unknown and reused ids are dropped, and far-apart members are split", () => {
  const batch = [finding("f1", 10), finding("f2", 12), finding("f3", 90), finding("f4", 95), finding("f5", 200)];
  const groups = cleanGroups([{ ids: ["f1", "f2", "f3", "f4", "nope"] }, { ids: ["f2", "f5"] }, "junk"], batch);
  assert.deepEqual(groups.map((group) => group.map((member) => member.id)), [["f1", "f2"], ["f3", "f4"]]);
});

test("a group keeps its most severe, then most confident, then most detailed finding", () => {
  assert.equal(representative([finding("a", 1), finding("b", 1, { severity: "medium" }), finding("c", 1, { confidence: 0.9 })]).id, "b");
  assert.equal(representative([finding("a", 1), finding("b", 1, { detail: "longer detail" })]).id, "b");
});

test("ranks by severity, then by how many agents reported a finding", () => {
  const ranked = rankBySupport([finding("a", 1, { confidence: 0.9 }), finding("b", 1), finding("c", 1, { severity: "high" })], new Map([["a", 1], ["b", 3], ["c", 1]]), 2);
  assert.deepEqual(ranked.map((candidate) => candidate.id), ["c", "b"]);
});

test("folds differently worded repeats into one finding with the model merge", async () => {
  const { config, trace } = await swarmFixture({ RB_CONFIG_SWARM_VOTES: "0" });
  const wordings = new Map([["c1/logic", "retries is never used"], ["c1/callers", "The retries argument is ignored by acquire"], ["global/promise", "Unused parameter"]]);
  const chat: Chat = async (request) => {
    const name = request.tools.at(-1)!.function.name;
    let args: unknown;
    if (name === "submit_groups") {
      const ids = [...String(request.messages[1]!.content).matchAll(/"id": "(f\d+)"/g)].map((match) => match[1]);
      args = { groups: [{ ids, problem: "retries is unused" }] };
    } else {
      const title = wordings.get(request.caller ?? "");
      args = { checked: [], findings: title ? [{ file: "src/pool.ts", start_line: 2, end_line: 2, severity: "medium", kind: "defect", title, detail: `${title}.`, confidence: 0.7 }] : [] };
    }
    return { role: "assistant", tool_calls: [{ id: "1", type: "function", function: { name, arguments: JSON.stringify(args) } }] };
  };
  const outcome = await swarmReview(config, chat, () => {});
  assert.equal(outcome.proposed, 3);
  assert.equal(outcome.findings.length, 1);
  const traced = trace();
  assert.equal(traced.merges[0].groups[0].ids.length, 3);
  assert.equal(traced.final[0].support, 3);
  assert.equal(traced.proposals.filter((proposal: { groupedInto: string | null }) => proposal.groupedInto).length, 2);
});
