import assert from "node:assert/strict";
import { test } from "node:test";
import { createChat, emptyUsage, type Usage } from "../src/llm.ts";

function replying(usage: Record<string, unknown>): typeof fetch {
  return (async () => new Response(JSON.stringify({
    choices: [{ message: { role: "assistant", content: "ok" } }],
    usage,
  }))) as typeof fetch;
}

test("totals usage for the run and for each caller that names itself", async () => {
  const usage = emptyUsage();
  const usageByCaller = new Map<string, Usage>();
  const chat = createChat({
    apiKey: "key", baseUrl: "https://example.test/v1", effort: null, usage, usageByCaller,
    fetchImpl: replying({ prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 60 }, cost: 0.5 }),
  });
  const request = { model: "test/model", messages: [], tools: [], timeoutMs: 5_000 };
  await chat({ ...request, caller: "s1" });
  await chat({ ...request, caller: "s1" });
  await chat({ ...request, caller: "verifier" });
  await chat(request);

  assert.deepEqual(usage, { calls: 4, promptTokens: 400, completionTokens: 40, cachedTokens: 240, costUsd: 2 });
  assert.deepEqual(usageByCaller.get("s1"), { calls: 2, promptTokens: 200, completionTokens: 20, cachedTokens: 120, costUsd: 1 });
  assert.deepEqual(usageByCaller.get("verifier"), { calls: 1, promptTokens: 100, completionTokens: 10, cachedTokens: 60, costUsd: 0.5 });
  assert.deepEqual([...usageByCaller.keys()], ["s1", "verifier"]);
});
