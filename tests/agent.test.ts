import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent.ts";
import { ModelError, type Chat, type ChatMessage, type ChatRequest } from "../src/llm.ts";
import { submitReview } from "../src/prompts.ts";
import type { Workspace } from "../src/tools.ts";

const workspace = { call: async (name: string) => JSON.stringify({ ok: true, tool: name }) } as unknown as Workspace;

function toolCall(name: string, args: string, id = "c1"): ChatMessage {
  return { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: args } }] };
}

/** A chat that replays scripted replies and records a copy of each request. */
function scripted(replies: Array<ChatMessage | Error>): { chat: Chat; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const chat: Chat = async (request) => {
    requests.push({ ...request, messages: [...request.messages] });
    const reply = replies.shift();
    if (!reply) throw new Error("script ran out");
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { chat, requests };
}

function options(chat: Chat, overrides: { deadline?: number; maxTurns?: number } = {}) {
  return {
    chat, model: "test/model", system: "system", prompt: "prompt", workspace, submit: submitReview,
    deadline: Date.now() + 3_600_000, maxTurns: 10, log: () => {}, ...overrides,
  };
}

test("runs tool calls, feeds results back, and returns the submission", async () => {
  const { chat, requests } = scripted([
    toolCall("read_diff", '{"start_line":1,"line_count":10}'),
    toolCall("submit_review", '{"findings":[{"file":"a.ts"}]}', "c2"),
  ]);
  const result = await runAgent(options(chat));
  assert.deepEqual(result, { findings: [{ file: "a.ts" }] });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]!.messages.at(-1), { role: "tool", tool_call_id: "c1", content: '{"ok":true,"tool":"read_diff"}' });
  assert.equal(requests[0]!.forceTool, undefined);
});

test("asks again when the submission is not valid JSON", async () => {
  const { chat, requests } = scripted([
    toolCall("submit_review", '{"findings":[{"file":"a.ts"'),
    toolCall("submit_review", '{"findings":[]}', "c2"),
  ]);
  assert.deepEqual(await runAgent(options(chat)), { findings: [] });
  assert.match(String(requests[1]!.messages.at(-1)!.content), /not valid JSON/);
});

test("accepts a JSON answer given as text, and nudges on plain prose", async () => {
  const { chat, requests } = scripted([
    { role: "assistant", content: "I have looked at the change." },
    { role: "assistant", content: 'Here it is:\n```json\n{"findings": []}\n```' },
  ]);
  assert.deepEqual(await runAgent(options(chat)), { findings: [] });
  assert.match(String(requests[1]!.messages.at(-1)!.content), /call submit_review/);
});

test("forces the submit tool on the last turn", async () => {
  const { chat, requests } = scripted([
    toolCall("read_diff", "{}"),
    toolCall("submit_review", '{"findings":[]}', "c2"),
  ]);
  await runAgent(options(chat, { maxTurns: 2 }));
  assert.equal(requests[0]!.forceTool, undefined);
  assert.equal(requests[1]!.forceTool, "submit_review");
  assert.match(String(requests[1]!.messages.at(-1)!.content), /Stop investigating/);
});

test("forces the submit tool when the deadline is near, and falls back when forcing is rejected", async () => {
  const { chat, requests } = scripted([
    new ModelError(400, "tool_choice is not supported"),
    toolCall("submit_review", '{"findings":[]}'),
  ]);
  await runAgent(options(chat, { deadline: Date.now() + 30_000 }));
  assert.equal(requests[0]!.forceTool, "submit_review");
  assert.equal(requests[1]!.forceTool, undefined);
});

test("fails when the model never submits or time has run out", async () => {
  const { chat } = scripted([toolCall("read_diff", "{}"), toolCall("read_diff", "{}", "c2")]);
  await assert.rejects(runAgent(options(chat, { maxTurns: 2 })), /did not submit within 2 turns/);
  await assert.rejects(runAgent(options(scripted([]).chat, { deadline: Date.now() - 1 })), /ran out of time/);
});
