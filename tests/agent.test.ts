import assert from "node:assert/strict";
import { test } from "node:test";
import { completeEntries, runAgent } from "../src/agent.ts";
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

test("asks for the submission when an ordinary turn fails, instead of giving up", async () => {
  const { chat, requests } = scripted([
    toolCall("read_diff", "{}"),
    new Error("The operation was aborted due to timeout"),
    toolCall("submit_review", '{"findings":["kept"]}', "c2"),
  ]);
  assert.deepEqual(await runAgent(options(chat)), { findings: ["kept"] });
  assert.equal(requests[2]!.forceTool, "submit_review");
  assert.match(String(requests[2]!.messages.at(-1)!.content), /Stop investigating/);
});

test("an ordinary turn may not use the time kept back for the submission", async () => {
  const { chat, requests } = scripted([toolCall("submit_review", '{"findings":[]}')]);
  await runAgent(options(chat, { deadline: Date.now() + 400_000 }));
  assert.ok(requests[0]!.timeoutMs <= 300_000, String(requests[0]!.timeoutMs));
});

test("fails when the model never submits or time has run out", async () => {
  const { chat } = scripted([toolCall("read_diff", "{}"), toolCall("read_diff", "{}", "c2")]);
  await assert.rejects(runAgent(options(chat, { maxTurns: 2 })), /did not submit within 2 turns/);
  await assert.rejects(runAgent(options(scripted([]).chat, { deadline: Date.now() - 1 })), /ran out of time/);
});

test("asks for a second look, then joins both submissions", async () => {
  const { chat, requests } = scripted([
    toolCall("submit_review", '{"findings":["first"]}'),
    toolCall("read_file", "{}", "c2"),
    toolCall("submit_review", '{"findings":["second"]}', "c3"),
  ]);
  const secondLook = {
    message: (round: number) => round === 1 ? "look again" : null,
    combine: (submissions: Array<Record<string, unknown>>) => ({ findings: submissions.flatMap((item) => item.findings as string[]) }),
  };
  assert.deepEqual(await runAgent({ ...options(chat), secondLook }), { findings: ["first", "second"] });
  assert.match(String(requests[1]!.messages.at(-1)!.content), /look again/);
});

test("runs every round the second look asks for, then joins all submissions", async () => {
  const { chat, requests } = scripted([
    toolCall("submit_review", '{"findings":["first"]}'),
    toolCall("submit_review", '{"findings":["a"]}', "c2"),
    toolCall("submit_review", '{"findings":["b"]}', "c3"),
  ]);
  const secondLook = {
    message: (round: number) => round <= 2 ? `round ${round}` : null,
    combine: (submissions: Array<Record<string, unknown>>) => ({ findings: submissions.flatMap((item) => item.findings as string[]) }),
  };
  assert.deepEqual(await runAgent({ ...options(chat), secondLook }), { findings: ["first", "a", "b"] });
  assert.match(String(requests[2]!.messages.at(-1)!.content), /round 2/);
  assert.equal(requests.length, 3);
});

test("keeps the first submission when the second look fails", async () => {
  const { chat } = scripted([toolCall("submit_review", '{"findings":["first"]}'), new Error("network down")]);
  const secondLook = { message: () => "look again", combine: (submissions: Array<Record<string, unknown>>) => submissions[0]! };
  assert.deepEqual(await runAgent({ ...options(chat), secondLook }), { findings: ["first"] });
});

test("skips the second look when little time is left", async () => {
  const { chat, requests } = scripted([toolCall("submit_review", '{"findings":["only"]}')]);
  const secondLook = { message: () => "look again", combine: () => ({ findings: [] }) };
  assert.deepEqual(await runAgent({ ...options(chat, { deadline: Date.now() + 100_000 }), secondLook }), { findings: ["only"] });
  assert.equal(requests.length, 1);
});

test("submits on the first turn when asked, then reads and adds more in a second look", async () => {
  const { chat, requests } = scripted([
    toolCall("submit_review", '{"findings":["from the prompt"]}'),
    toolCall("read_file", '{"path":"a.ts"}'),
    new Error("timed out"),
    new Error("timed out again"),
  ]);
  const secondLook = { message: () => "look again", combine: (submissions: Array<Record<string, unknown>>) => ({ findings: submissions.flatMap((item) => item.findings as string[]) }) };
  assert.deepEqual(await runAgent({ ...options(chat), secondLook, submitFirst: true }), { findings: ["from the prompt"] });
  assert.equal(requests[0]!.forceTool, "submit_review", "the first turn must be the submission");
  assert.equal(requests[1]!.forceTool, undefined, "the second look may read");
});

const CUT_OFF = '{"findings":[{"file":"a.ts","detail":"has } and \\" inside"},{"file":"b.ts","nested":{"n":1}},{"file":"c.t';

test("completeEntries recovers the finished entries of a cut-off submission", () => {
  assert.deepEqual(completeEntries(CUT_OFF), {
    findings: [{ file: "a.ts", detail: 'has } and " inside' }, { file: "b.ts", nested: { n: 1 } }],
  });
  assert.deepEqual(completeEntries('{"verdicts": [ {"id":"s1-1","verdict":"confirmed"} , {"id":'), {
    verdicts: [{ id: "s1-1", verdict: "confirmed" }],
  });
  assert.equal(completeEntries('{"findings":[{"file":"a.t'), null);
  assert.equal(completeEntries("not json at all"), null);
});

test("keeps the complete entries of a cut-off submission when time is nearly up", async () => {
  const { chat, requests } = scripted([toolCall("submit_review", CUT_OFF)]);
  const result = await runAgent(options(chat, { deadline: Date.now() + 50_000 }));
  assert.deepEqual((result.findings as Array<{ file: string }>).map((finding) => finding.file), ["a.ts", "b.ts"]);
  assert.equal(requests.length, 1);
});

test("asks again after a cut-off submission while there is time, and falls back to its entries if that fails", async () => {
  const asked = scripted([toolCall("submit_review", CUT_OFF), toolCall("submit_review", '{"findings":[]}', "c2")]);
  assert.deepEqual(await runAgent(options(asked.chat)), { findings: [] });
  assert.equal(asked.requests.length, 2);

  const failed = scripted([toolCall("submit_review", CUT_OFF), new ModelError(400, "bad request")]);
  const result = await runAgent(options(failed.chat));
  assert.equal((result.findings as unknown[]).length, 2);
});
