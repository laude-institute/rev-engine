import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent.ts";
import { submitReview } from "../src/prompts.ts";
import type { Workspace } from "../src/tools.ts";
import { createChat, emptyUsage, formatCost, roundedCost, ModelError, type Usage } from "../src/llm.ts";

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
    response_output: [
      { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "sealed" },
      { type: "message", content: [{ type: "output_text", text: "looking" }] },
      { type: "function_call", call_id: "call_2", name: "read_file", arguments: "{\"path\":\"b.ts\"}" },
    ],
    role: "assistant",
    content: "looking",
    tool_calls: [{ id: "call_2", type: "function", function: { name: "read_file", arguments: "{\"path\":\"b.ts\"}" } }],
    reasoning_details: [{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "sealed" }],
  });
  assert.deepEqual(usage, { calls: 1, promptTokens: 100, completionTokens: 10, cachedTokens: 60, costUsd: null });

  await chat({ model: "test-model", tools: [tool], timeoutMs: 5_000, messages: [], forceTool: "read_file" });
  assert.deepEqual(sent[1]!.body.tool_choice, { type: "function", name: "read_file" });
});

const directRequest = { model: "test-model", messages: [], tools: [], timeoutMs: 100 };
const textOutput = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }];

function directClient(fetchImpl: typeof fetch, usage = emptyUsage(), usageByCaller?: Map<string, Usage>) {
  return createChat({ apiKey: "fake", baseUrl: "https://api.openai.com/v1/", effort: "high", usage, usageByCaller, fetchImpl });
}

test("replays every Responses output item in order, including phase, after saving a transcript", async () => {
  const output = [
    { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "first" },
    { type: "message", id: "msg_1", status: "completed", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Checking.", annotations: [] }] },
    { type: "reasoning", id: "rs_2", summary: [], encrypted_content: "second" },
    { type: "function_call", id: "fc_1", status: "completed", call_id: "call_1", name: "read_file", arguments: "{}" },
  ];
  const bodies: any[] = [];
  const chat = directClient(async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ status: "completed", output });
  });
  const reply = await chat(directRequest);
  await chat({ ...directRequest, messages: [JSON.parse(JSON.stringify(reply)), { role: "tool", tool_call_id: "call_1", content: "data" }] });
  assert.deepEqual(bodies[1].input, [...output, { type: "function_call_output", call_id: "call_1", output: "data" }]);
});

test("retains assistant text from normalized transcripts and lets tool-free requests use auto", async () => {
  const bodies: any[] = [];
  const chat = directClient(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ status: "completed", output: textOutput });
  });
  await chat({ ...directRequest, effort: "low", messages: [{ role: "assistant", content: "earlier" }, { role: "user", content: "next" }] });
  assert.deepEqual(bodies[0].input, [{ role: "assistant", content: "earlier" }, { role: "user", content: "next" }]);
  assert.equal(bodies[0].tool_choice, "auto");
  assert.deepEqual(bodies[0].reasoning, { effort: "low" });
});

test("reasoning-only truncation can continue through the real agent loop without replaying an orphan", async () => {
  let calls = 0;
  const usage = emptyUsage();
  const chat = directClient(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    calls += 1;
    if (calls === 1) return Response.json({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "reasoning", id: "unfinished", summary: [], encrypted_content: "partial" }], usage: { input_tokens: 100, output_tokens: 16000 } });
    assert.ok(!body.input.some((item: any) => item.type === "reasoning" || item.role === "assistant"));
    assert.match(body.input.at(-1).content, /Continue/);
    return Response.json({ status: "completed", output: [{ type: "function_call", call_id: "c1", name: "submit_review", arguments: '{"findings":[]}' }] });
  }, usage);
  const result = await runAgent({ chat, model: "test-model", system: "system", prompt: "prompt", submit: submitReview,
    workspace: { call: async () => "" } as unknown as Workspace, deadline: Date.now() + 300_000, maxTurns: 3, log: () => {} });
  assert.deepEqual(result, { findings: [] });
  assert.equal(calls, 2);
  assert.equal(usage.completionTokens, 16000);
});

test("keeps complete findings from an incomplete tool submission", async () => {
  const chat = directClient(async () => Response.json({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "function_call", call_id: "c1", name: "submit_review", arguments: '{"findings":[{"file":"a.ts"},{"file":"b' }] }));
  const result = await runAgent({ chat, model: "test-model", system: "system", prompt: "prompt", submit: submitReview,
    workspace: { call: async () => "" } as unknown as Workspace, deadline: Date.now() + 300_000, maxTurns: 1, log: () => {} });
  assert.deepEqual(result, { findings: [{ file: "a.ts" }] });
});

test("Responses second look still reads tools and combines submissions", async () => {
  const bodies: any[] = [];
  const outputs = [
    [{ type: "function_call", call_id: "c1", name: "submit_review", arguments: '{"findings":["first"]}' }],
    [{ type: "function_call", call_id: "c2", name: "read_file", arguments: '{"path":"a.ts"}' }],
    [{ type: "function_call", call_id: "c3", name: "submit_review", arguments: '{"findings":["second"]}' }],
  ];
  const chat = directClient(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ status: "completed", output: outputs.shift() });
  });
  const result = await runAgent({ chat, model: "test-model", system: "system", prompt: "prompt", submit: submitReview,
    workspace: { call: async () => "file contents" } as unknown as Workspace, deadline: Date.now() + 600_000, maxTurns: 10, log: () => {},
    secondLook: { message: (round) => round === 1 ? "look again" : null, combine: (values) => ({ findings: values.flatMap((value) => value.findings as string[]) }) } });
  assert.deepEqual(result, { findings: ["first", "second"] });
  assert.equal(bodies[1].tool_choice, "required");
  assert.match(bodies[1].input.at(-1).output, /look again/);
  assert.equal(bodies[2].input.at(-1).output, "file contents");
});

test("tracks Responses usage per caller and preserves unknown cost across known-cost calls", async () => {
  const usage = emptyUsage();
  const byCaller = new Map<string, Usage>();
  const chat = directClient(async () => Response.json({ status: "completed", output: textOutput,
    usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 60 } } }), usage, byCaller);
  await chat({ ...directRequest, caller: "s1" });
  await chat({ ...directRequest, caller: "s1" });
  await chat({ ...directRequest, caller: "verifier" });
  assert.deepEqual(usage, { calls: 3, promptTokens: 300, completionTokens: 30, cachedTokens: 180, costUsd: null });
  assert.deepEqual(byCaller.get("s1"), { calls: 2, promptTokens: 200, completionTokens: 20, cachedTokens: 120, costUsd: null });
  assert.equal(byCaller.get("verifier")?.calls, 1);
  const router = createChat({ apiKey: "fake", baseUrl: "https://openrouter.ai/api/v1", effort: null, usage,
    fetchImpl: replying({ cost: 0.5 }) });
  await router(directRequest);
  assert.equal(usage.costUsd, null);
  assert.equal(formatCost(usage.costUsd), "unknown");
  assert.equal(JSON.stringify({ cost_usd: roundedCost(usage.costUsd) }), '{"cost_usd":null}');
  assert.equal(formatCost(0, 2), "$0.00");
  assert.equal(roundedCost(1.23456789), 1.234568);
});

for (const status of [429, 503]) {
  test(`retries a Responses HTTP ${status} within the request budget`, async () => {
    let attempts = 0;
    const chat = directClient(async () => ++attempts === 1 ? new Response("retry", { status }) : Response.json({ output: textOutput }));
    assert.equal((await chat({ ...directRequest, timeoutMs: 5_000 })).content, "ok");
    assert.equal(attempts, 2);
  });
}

test("does not retry a Responses HTTP 400", async () => {
  let attempts = 0;
  const chat = directClient(async () => { attempts += 1; return new Response("bad request", { status: 400 }); });
  await assert.rejects(chat({ ...directRequest, timeoutMs: 5_000 }), (error: unknown) => error instanceof ModelError && error.status === 400);
  assert.equal(attempts, 1);
});

for (const [name, body] of [
  ["non-JSON", "bad json"],
  ["missing output", '{}'],
  ["embedded error", '{"error":{"message":"upstream failed"}}'],
  ["failed status", '{"status":"failed","output":[]}'],
  ["invalid item", '{"status":"completed","output":[null]}'],
]) {
  test(`rejects Responses ${name} without exceeding a short retry budget`, async () => {
    let attempts = 0;
    const chat = directClient(async () => { attempts += 1; return new Response(body); });
    await assert.rejects(chat(directRequest), (error: unknown) => error instanceof ModelError && error.status === 502);
    assert.equal(attempts, 1);
  });
}

test("does not leak Responses output into a chat-completions request", async () => {
  let sent: any;
  const chat = createChat({ apiKey: "fake", baseUrl: "https://openrouter.ai/api/v1", effort: null, usage: emptyUsage(),
    fetchImpl: async (_url, init) => { sent = JSON.parse(String(init?.body)); return Response.json({ choices: [{ message: { content: "ok" } }] }); } });
  await chat({ ...directRequest, messages: [{ role: "assistant", content: "earlier", response_output: textOutput }] });
  assert.deepEqual(sent.messages, [{ role: "assistant", content: "earlier" }]);
});
