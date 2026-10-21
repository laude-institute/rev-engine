import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chunk, chunkContext, chunkSymbols, findMentions, splitDiff, units } from "../experiments/prototypes/swarm/chunks.ts";
import { SWARM_SYSTEM, SWARM_VERIFIER_SYSTEM, submitFastReview, submitSwarmReview } from "../experiments/prototypes/swarm/prompts.ts";
import { cleanGroups, representative } from "../experiments/prototypes/swarm/merge.ts";
import { promptLines, sawLines } from "../experiments/prototypes/swarm/seen.ts";
import { FAST_SECOND_LOOK, fastPace, hedge, rankBySupport, swarmReview, swarmSettings, tally } from "../experiments/prototypes/swarm/review.ts";
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
  assert.ok(!(submitFastReview.function.parameters.required as string[]).includes("checked"));
  assert.equal(swarmSettings({}).target, 0);
  assert.equal(swarmSettings({ RB_CONFIG_SWARM_TARGET: "60" }).target, 60);
  assert.throws(() => swarmSettings({ RB_CONFIG_SWARM_TARGET: "10" }), /RB_CONFIG_SWARM_TARGET/);
  assert.equal(swarmSettings({ RB_CONFIG_SWARM_SORT: "latency" }).sort, "latency");
  assert.throws(() => swarmSettings({ RB_CONFIG_SWARM_SORT: "cheapest" }), /RB_CONFIG_SWARM_SORT/);
  assert.equal(swarmSettings({ RB_CONFIG_SWARM_EFFORT: "low" }).effort, "low");
  assert.throws(() => swarmSettings({ RB_CONFIG_SWARM_EFFORT: "max" }), /RB_CONFIG_SWARM_EFFORT/);
  assert.equal(swarmSettings({ RB_CONFIG_SWARM_REASONING_TOKENS: "1500" }).reasoningTokens, 1500);
  assert.equal(swarmSettings({}).reasoningTokens, null);
  assert.throws(() => swarmSettings({ RB_CONFIG_SWARM_REASONING_TOKENS: "10" }), /RB_CONFIG_SWARM_REASONING_TOKENS/);
});

test("the fast pace fits every phase inside the target", () => {
  const pace = fastPace(60);
  assert.equal(pace.verifyTurns, 1);
  assert.ok(pace.wrapUpMs! < 60_000 * pace.reviewShare, "agents get ordinary turns before they must submit");
  assert.ok(pace.hedgeMs < pace.callTimeoutMs, "a slow call is sent again before it would time out");
  assert.ok(pace.minStartMs < 60_000 * pace.reviewShare);
  assert.equal(pace.minRetryMs, Infinity, "there is no time to run an agent twice");
  assert.ok(fastPace(60, false).hedgeMs < pace.hedgeMs, "without reasoning, a slow call is sent again sooner");
});

test("sends a slow call again and keeps the first answer, and passes a fast call through", async () => {
  const sent = { count: 0 };
  let calls = 0;
  const reply = (content: string) => ({ role: "assistant" as const, content });
  const slowFirst: Chat = async () => {
    calls += 1;
    const delay = calls === 1 ? 500 : 10;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return reply(`call ${calls === 1 ? "first" : "second"}`);
  };
  const request: ChatRequest = { model: "m", messages: [], tools: [], timeoutMs: 5_000 };
  assert.equal((await hedge(slowFirst, 50, sent)(request)).content, "call second");
  assert.equal(sent.count, 1);

  const fast: Chat = async () => reply("quick");
  assert.equal((await hedge(fast, 50, sent)(request)).content, "quick");
  assert.equal(sent.count, 1, "a call that answers in time is not sent again");

  const failing: Chat = async () => { throw new ModelError(500, "down"); };
  await assert.rejects(hedge(failing, 50, sent)(request), /down/);
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

test("a fast review asks for few findings, needs no checklist, and shows verifiers the code instead of letting them read", async () => {
  const { config } = await swarmFixture();
  const requests: ChatRequest[] = [];
  const chat: Chat = async (request) => {
    requests.push(request);
    return submitting(request);
  };
  const saved = process.env.RB_CONFIG_SWARM_TARGET;
  process.env.RB_CONFIG_SWARM_TARGET = "60";
  try {
    const outcome = await swarmReview(config, chat, () => {});
    assert.equal(outcome.findings.length, 1);
  } finally {
    if (saved === undefined) delete process.env.RB_CONFIG_SWARM_TARGET;
    else process.env.RB_CONFIG_SWARM_TARGET = saved;
  }
  const reviewer = requests.find((request) => request.tools.at(-1)!.function.name === "submit_review")!;
  assert.match(String(reviewer.messages[1]!.content), /within 60 seconds[\s\S]*at most 6 findings/);
  assert.ok(!(reviewer.tools.at(-1)!.function.parameters.required as string[]).includes("checked"));
  const verifiers = requests.filter((request) => request.tools.at(-1)!.function.name === "submit_verdicts");
  assert.equal(verifiers.length, 3);
  assert.match(String(verifiers[0]!.messages[1]!.content), /<code finding="f1" path="src\/pool.ts" lines="1-17">\n1: export class Pool/);
  assert.equal(verifiers[0]!.forceTool, "submit_verdicts", "a one-turn verifier is told to submit at once");
});

test("a fast agent's later rounds add to its first findings", () => {
  const combined = FAST_SECOND_LOOK.combine([{ findings: [1], checked: ["a"] }, { findings: [2] }, { findings: [] }]);
  assert.deepEqual(combined, { findings: [1, 2], checked: ["a"] });
  assert.equal(FAST_SECOND_LOOK.message(4), null, "the rounds stop");
});

test("a fast review that loses most agents runs them again at the normal pace instead of failing", async () => {
  const { config, trace } = await swarmFixture();
  const requests: ChatRequest[] = [];
  const chat: Chat = async (request) => {
    requests.push(request);
    if (request.tools.at(-1)!.function.name === "submit_review" && String(request.messages[1]!.content).includes("within 60 seconds")) {
      throw new ModelError(400, "refused");
    }
    return submitting(request);
  };
  const saved = process.env.RB_CONFIG_SWARM_TARGET;
  process.env.RB_CONFIG_SWARM_TARGET = "60";
  try {
    const outcome = await swarmReview(config, chat, () => {});
    assert.equal(outcome.findings.length, 1);
  } finally {
    if (saved === undefined) delete process.env.RB_CONFIG_SWARM_TARGET;
    else process.env.RB_CONFIG_SWARM_TARGET = saved;
  }
  const agents = trace().agents as Array<{ caller: string; status: string }>;
  assert.equal(agents.length, 9 * 2, "each of the 9 agents ran fast, then again at the normal pace");
  assert.equal(agents.filter((agent) => agent.status === "ok").length, 9);
  const rerun = requests.find((request) => request.tools.at(-1)!.function.name === "submit_review" && !String(request.messages[1]!.content).includes("within 60 seconds"))!;
  assert.match(String(rerun.messages[1]!.content), /Your budget is 16 turns|Your budget is 40 turns/);
});

test("fast agents that hand in nothing count as lost, and the calls are timed in the trace", async () => {
  const { config, trace } = await swarmFixture();
  const requests: ChatRequest[] = [];
  const chat: Chat = async (request) => {
    requests.push(request);
    const fast = String(request.messages[1]?.content).includes("within 60 seconds");
    if (request.tools.at(-1)!.function.name === "submit_review" && fast) {
      const empty = { findings: [] };
      return { role: "assistant", reasoning_details: [{ type: "reasoning.text", text: "nothing here" }], tool_calls: [{ id: "1", type: "function", function: { name: "submit_review", arguments: JSON.stringify(empty) } }] };
    }
    return submitting(request);
  };
  const saved = { target: process.env.RB_CONFIG_SWARM_TARGET, effort: process.env.RB_CONFIG_SWARM_EFFORT };
  process.env.RB_CONFIG_SWARM_TARGET = "60";
  process.env.RB_CONFIG_SWARM_EFFORT = "low";
  try {
    const outcome = await swarmReview(config, chat, () => {});
    assert.equal(outcome.findings.length, 1, "the normal pace rerun found it");
  } finally {
    for (const [name, value] of [["RB_CONFIG_SWARM_TARGET", saved.target], ["RB_CONFIG_SWARM_EFFORT", saved.effort]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const first = requests.find((request) => request.tools.at(-1)!.function.name === "submit_review")!;
  assert.equal(first.forceTool, undefined, "a fast agent's first turn is asked for, not forced");
  assert.equal(first.effort, "low");
  const recorded = trace();
  assert.equal(recorded.agents.filter((agent: { status: string }) => agent.status === "empty").length, 9);
  assert.ok(recorded.calls.length >= requests.length);
  assert.ok(recorded.calls.some((call: { reasoningChars: number }) => call.reasoningChars === "nothing here".length));
});

test("rich context shows the code around uses, the definitions called, matching tests and the code before", async () => {
  const { calledNames, findDefinitions, richContext, testFilesFor } = await import("../experiments/prototypes/swarm/context.ts");
  const repo = mkdtempSync(join(tmpdir(), "swarm-rich-"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, "test"));
  writeFileSync(join(repo, "src/helpers.ts"), "export function retryDelay(attempt) {\n  return attempt * 100;\n}\n");
  writeFileSync(join(repo, "test/pool.test.ts"), `import { Pool } from "../src/pool";\n${"// filler\n".repeat(20)}test("acquire waits", () => {\n  new Pool().acquire(5, 2);\n});\n`);
  execFileSync("git", ["-C", repo, "add", "."]);
  const diff = `diff --git a/src/pool.ts b/src/pool.ts
--- a/src/pool.ts
+++ b/src/pool.ts
@@ -1,3 +1,4 @@
 export class Pool {
-  function acquire(timeout) {
+  function acquire(timeout, retries) {
+    wait(retryDelay(retries));
 }
`;
  const piece = chunk(units(splitDiff(diff)), 10)[0]!;
  assert.deepEqual(calledNames(piece), ["wait", "retryDelay"], "names the chunk calls, not the ones it defines");
  const definitions = await findDefinitions(repo, calledNames(piece));
  assert.deepEqual(definitions.get("retryDelay")?.map((found) => [found.path, found.line]), [["src/helpers.ts", 1]]);
  assert.deepEqual(testFilesFor(["src/pool.ts"], ["src/pool.ts", "test/pool.test.ts", "test/other.test.ts", "docs/pool.md"]), ["test/pool.test.ts"]);
  const files: Record<string, string> = {
    "src/helpers.ts": "export function retryDelay(attempt) {\n  return attempt * 100;\n}\n",
    "test/pool.test.ts": readFileSync(join(repo, "test/pool.test.ts"), "utf8"),
    "src/other.ts": `${"x\n".repeat(30)}const p = pool.acquire(1);\n${"y\n".repeat(30)}`,
  };
  const text = await richContext(piece, {
    headFile: async (path) => files[path] ?? null,
    baseFile: async (path) => path === "src/pool.ts" ? "export class Pool {\n  function acquire(timeout) {\n}\n" : null,
    mentions: new Map([["acquire", [{ path: "src/other.ts", line: 31, text: "const p = pool.acquire(1);" }]]]),
    definitions, allFiles: ["src/pool.ts", "test/pool.test.ts"],
  });
  assert.match(text, /<code path="src\/other\.ts">\n25: x[\s\S]*31: const p = pool\.acquire\(1\);[\s\S]*37: y\n<\/code>/);
  assert.match(text, /<definition name="retryDelay" path="src\/helpers\.ts">\n1: export function retryDelay\(attempt\) \{/);
  assert.match(text, /<test path="test\/pool\.test\.ts">[\s\S]*new Pool\(\)\.acquire\(5, 2\);/);
  assert.match(text, /<before path="src\/pool\.ts">\n1: export class Pool \{\n2:   function acquire\(timeout\) \{/);
});

test("a fast verifier is shown where the names a finding mentions are used", async () => {
  const { findingEvidence, namesInFinding } = await import("../experiments/prototypes/swarm/context.ts");
  assert.deepEqual(namesInFinding("The test asserts `LANGUAGE_LABEL` ends in CY, but formatLabel adds it"), ["LANGUAGE_LABEL", "formatLabel"]);
  const files: Record<string, string> = { "src/labels.ts": `${"x\n".repeat(20)}export const LANGUAGE_LABEL = "Cymraeg - CY";\n${"y\n".repeat(20)}` };
  const text = await findingEvidence(
    [{ id: "f1", file: "test/labels.test.ts", startLine: 3, endLine: 3, title: "Test hardcodes the CY suffix", detail: "It assumes `LANGUAGE_LABEL` has no suffix." }],
    new Map([["LANGUAGE_LABEL", [{ path: "src/labels.ts", line: 21, text: "export const LANGUAGE_LABEL" }, { path: "test/labels.test.ts", line: 3, text: "own line" }]]]),
    async (path) => files[path] ?? null,
  );
  assert.match(text, /<uses finding="f1" name="LANGUAGE_LABEL" path="src\/labels\.ts">\n16: x[\s\S]*21: export const LANGUAGE_LABEL = "Cymraeg - CY";/);
  assert.doesNotMatch(text, /labels\.test\.ts/, "the finding's own lines are already shown");
});

test("reads which lines of which files a prompt showed", () => {
  const prompt = [
    "<diff>\ndiff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -10,3 +10,4 @@ export\n x\n+y\n</diff>",
    "<file_after_change path=\"src/b.ts\" lines=\"5-7\">\n5: one\n6: two\n7: three\n</file_after_change>",
    "<test path=\"test/b.test.ts\">\n1: a\n2: b\n...\n40: c\n</test>",
    "<before path=\"src/b.ts\">\n100: old\n</before>",
    "- helper\n  src/c.ts:12: helper()",
  ].join("\n\n");
  const seen = promptLines(prompt);
  assert.deepEqual(sawLines(seen, "src/a.ts", 13, 13), ["diff"]);
  assert.deepEqual(sawLines(seen, "src/a.ts", 14, 20), []);
  assert.deepEqual(sawLines(seen, "src/b.ts", 7, 9), ["file_after_change"]);
  // Lines of the file before the change are numbered differently, so they do not count.
  assert.deepEqual(sawLines(seen, "src/b.ts", 100, 100), []);
  assert.deepEqual(sawLines(seen, "test/b.test.ts", 3, 39), []);
  assert.deepEqual(sawLines(seen, "test/b.test.ts", 40, 40), ["test"]);
  assert.deepEqual(sawLines(seen, "src/c.ts", 10, 14), ["mention"]);
});
