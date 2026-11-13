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

test("sends a per-call effort, a reasoning cap in its place, and a provider sort to OpenRouter", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
  }) as unknown as typeof fetch;
  const chat = createChat({ apiKey: "key", baseUrl: "https://openrouter.ai/api/v1", effort: "high", usage: emptyUsage(), fetchImpl });
  const request = { model: "test/model", messages: [], tools: [], timeoutMs: 5_000 };
  await chat(request);
  await chat({ ...request, effort: "low" });
  await chat({ ...request, effort: "low", reasoningTokens: 1500, providerSort: "latency" });
  assert.deepEqual(bodies.map((body) => body.reasoning), [{ effort: "high" }, { effort: "low" }, { max_tokens: 1500 }]);
  assert.deepEqual(bodies[2]!.provider, { sort: "latency" });
  await chat({ ...request, providers: ["together"] });
  assert.deepEqual(bodies[3]!.provider, { only: ["together"], allow_fallbacks: false });
});

test("reads which provider served a call, and never sends it back", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ provider: "Example", choices: [{ message: { role: "assistant", content: "ok" } }] }))) as unknown as typeof fetch;
  const chat = createChat({ apiKey: "key", baseUrl: "https://openrouter.ai/api/v1", effort: null, usage: emptyUsage(), fetchImpl });
  const reply = await chat({ model: "test/model", messages: [], tools: [], timeoutMs: 5_000 });
  assert.equal(reply.provider, "Example");
  assert.ok(!JSON.stringify(reply).includes("Example"));
});

test("talks to OpenAI directly through the Responses API", async () => {
  const sent: Array<{ url: string; body: any }> = [];
  const fetchImpl = (async (url: string, init: { body: string }) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      output: [
        { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "sealed" },
        { type: "message", content: [{ type: "output_text", text: "looking" }] },
        { type: "function_call", call_id: "call_2", name: "read_file", arguments: "{\"path\":\"b.ts\"}" },
      ],
      usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 60 } },
    }));
  }) as unknown as typeof fetch;
  const usage = emptyUsage();
  const chat = createChat({ apiKey: "key", baseUrl: "https://api.openai.com/v1", effort: "high", usage, fetchImpl });
  const tool = { type: "function" as const, function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: {} } } };
  const reasoning = [{ type: "reasoning", id: "rs_0", summary: [], encrypted_content: "earlier" }];
  const reply = await chat({
    model: "test-model",
    tools: [tool],
    timeoutMs: 5_000,
    messages: [
      { role: "system", content: "Review the change." },
      { role: "assistant", content: null, reasoning_details: reasoning, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "contents" },
    ],
  });

  assert.equal(sent[0]!.url, "https://api.openai.com/v1/responses");
  assert.deepEqual(sent[0]!.body, {
    model: "test-model",
    input: [
      { role: "system", content: "Review the change." },
      ...reasoning,
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a.ts\"}" },
      { type: "function_call_output", call_id: "call_1", output: "contents" },
    ],
    tools: [{ type: "function", name: "read_file", description: "Read a file", parameters: { type: "object", properties: {} }, strict: false }],
    tool_choice: "required",
    max_output_tokens: 16_000,
    store: false,
    include: ["reasoning.encrypted_content"],
    reasoning: { effort: "high" },
  });
  assert.deepEqual(reply, {
    role: "assistant",
    content: "looking",
    tool_calls: [{ id: "call_2", type: "function", function: { name: "read_file", arguments: "{\"path\":\"b.ts\"}" } }],
    reasoning_details: [{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "sealed" }],
  });
  assert.deepEqual(usage, { calls: 1, promptTokens: 100, completionTokens: 10, cachedTokens: 60, costUsd: 0 });

  await chat({ model: "test-model", tools: [tool], timeoutMs: 5_000, messages: [], forceTool: "read_file" });
  assert.deepEqual(sent[1]!.body.tool_choice, { type: "function", name: "read_file" });
});
