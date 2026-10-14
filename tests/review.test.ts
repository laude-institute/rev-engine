import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import type { Chat, ChatMessage } from "../src/llm.ts";
import { naiveReview } from "../src/naive.ts";
import { review } from "../src/review.ts";

let dir = "";

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "review-test-"));
  await writeFile(join(dir, "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  await writeFile(join(dir, "diff.patch"), [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1 +1,2 @@",
    " export const a = 1;",
    "+export const b = 2;",
    "",
  ].join("\n"));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function configFor(env: Record<string, string> = {}) {
  return loadConfig({
    RB_NWO: "owner/repo", RB_PR_NUMBER: "1", RB_BASE: "a".repeat(40), RB_HEAD: "b".repeat(40),
    RB_OUT: join(dir, "out", "findings.json"), OPENROUTER_API_KEY: "test-key",
    RB_REPO: dir, RB_DIFF: join(dir, "diff.patch"), RB_PR_JSON: join(dir, "missing.json"),
    RB_CONFIG_MODEL: "test/model", RB_CONFIG_SECOND_LOOK: "off", ...env,
  });
}

/** A model that submits the given findings on every review, and counts the reviews. */
function reviewer(findings: unknown[]): { chat: Chat; reviews: () => number } {
  let count = 0;
  const chat: Chat = async () => {
    count += 1;
    const reply: ChatMessage = {
      role: "assistant", content: null,
      tool_calls: [{ id: `c${count}`, type: "function", function: { name: "submit_review", arguments: JSON.stringify({ findings }) } }],
    };
    return reply;
  };
  return { chat, reviews: () => count };
}

test("an empty review is retried once, and an empty retry is final", async () => {
  const { chat, reviews } = reviewer([]);
  const logs: string[] = [];
  const outcome = await review(configFor(), chat, (message) => logs.push(message));
  assert.equal(reviews(), 2);
  assert.deepEqual(outcome.findings, []);
  assert.ok(logs.includes("retry (test/model): 0 finding(s)"));
});

test("an empty review is not retried when the retry is off", async () => {
  const { chat, reviews } = reviewer([]);
  await review(configFor({ RB_CONFIG_RETRY_EMPTY: "off" }), chat, () => {});
  assert.equal(reviews(), 1);
});

test("an empty review is not retried when too little time is left", async () => {
  const { chat, reviews } = reviewer([]);
  const logs: string[] = [];
  await review(configFor({ RB_CONFIG_TIME_BUDGET: "60" }), chat, (message) => logs.push(message));
  assert.equal(reviews(), 1);
  assert.ok(logs.includes("retry skipped: too little review time is left"));
});

test("a review with findings is not retried", async () => {
  const finding = { file: "a.ts", start_line: 2, end_line: 2, severity: "low", kind: "maintainability", title: "Unused", detail: "b is never read." };
  const { chat, reviews } = reviewer([finding]);
  await review(configFor({ RB_CONFIG_VERIFY: "off" }), chat, () => {});
  assert.equal(reviews(), 1);
});

test("the naive baseline makes one call with no tools but the submit tool", async () => {
  const finding = { file: "a.ts", start_line: 2, end_line: 2, severity: "low", kind: "maintainability", title: "Unused", detail: "b is never read." };
  const requests: Array<{ tools: number }> = [];
  const chat: Chat = async (request) => {
    requests.push({ tools: request.tools.length });
    return { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "submit_review", arguments: JSON.stringify({ findings: [finding] }) } }] };
  };
  const outcome = await naiveReview(configFor({ RB_CONFIG_NAIVE: "on" }), chat, () => {});
  assert.deepEqual(requests, [{ tools: 1 }]);
  assert.equal(outcome.findings.length, 1);
  assert.equal(outcome.verified, false);
});
