import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_CONTEXT_CHARS, runAgent, type SecondLook } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { naiveReview } from "../src/naive.ts";
import { claudeCodeChat, claudeCodeProblem, claudeCodeSettings, claudeLoginProblem, claudeModel, serveTools } from "../src/claude-code.ts";
import { emptyUsage, type ChatMessage, type ChatRequest, type Usage } from "../src/llm.ts";
import { submitReview } from "../src/prompts.ts";
import { readTools, type Workspace } from "../src/tools.ts";

const workspace = { call: async (name: string, args: string) => JSON.stringify({ ok: true, tool: name, args: JSON.parse(args) }) } as unknown as Workspace;

/**
 * A stand-in for claude. Each run records its arguments and standard input, then plays
 * the next step of script.json: print its events and a result, one per line as claude's
 * stream-json output does, exit with an error, or hang until stopped.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv.includes("--version")) { console.log("2.1.321"); process.exit(0); }
const here = import.meta.dirname;
let calls = 0;
try { calls = readFileSync(join(here, "calls.jsonl"), "utf8").split("\\n").filter(Boolean).length; } catch {}
const step = JSON.parse(readFileSync(join(here, "script.json"), "utf8"))[calls] ?? { exit: 1, stderr: "script ran out" };
if (step.ignoreStop) process.on("SIGTERM", () => appendFileSync(join(here, "signals"), "SIGTERM"));
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (stdin += chunk));
// With splitCharacters, a line is written in two parts that cut a multi-byte character in half.
const write = (value) => new Promise((written) => {
  const bytes = Buffer.from(JSON.stringify(value) + "\\n");
  const cut = step.splitCharacters ? bytes.findIndex((byte) => byte > 0x7f) + 1 : 0;
  if (!cut) return process.stdout.write(bytes, written);
  process.stdout.write(bytes.subarray(0, cut), () => setTimeout(() => process.stdout.write(bytes.subarray(cut), written), 50));
});
process.stdin.on("end", async () => {
  appendFileSync(join(here, "calls.jsonl"), JSON.stringify({ args: process.argv.slice(2), stdin }) + "\\n");
  for (const event of step.events ?? []) await write(event);
  if (step.hang) return setInterval(() => {}, 1000);
  if (step.stderr) process.stderr.write(step.stderr);
  if (step.result) await write(step.result);
  process.exitCode = step.exit ?? 0;
});
`;

interface Step {
  events?: unknown[];
  result?: Record<string, unknown>;
  exit?: number;
  stderr?: string;
  hang?: boolean;
  ignoreStop?: boolean;
  splitCharacters?: boolean;
}

interface Call {
  args: string[];
  stdin: string;
}

function fake(steps: Step[]): { command: string; calls: () => Call[] } {
  const dir = mkdtempSync(join(tmpdir(), "rev-fake-claude-"));
  const command = join(dir, "claude.mjs");
  writeFileSync(command, FAKE_CLAUDE);
  chmodSync(command, 0o755);
  writeFileSync(join(dir, "script.json"), JSON.stringify(steps));
  return {
    command,
    calls: () => {
      try {
        return readFileSync(join(dir, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Call);
      } catch {
        return [];
      }
    },
  };
}

function done(findings: unknown[], turns = 4, events: unknown[] = []): Step {
  return {
    events,
    result: {
      type: "result", subtype: "success", is_error: false, num_turns: turns, total_cost_usd: 0.25,
      usage: { input_tokens: 10, cache_read_input_tokens: 300, cache_creation_input_tokens: 90, output_tokens: 50 },
      structured_output: { findings },
    },
  };
}

const outOfTurns: Step = { result: { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 7 } };

/** The events claude prints for a response and for the results of its tool calls, one event for each block. */
function said(id: string, ...content: Array<Record<string, unknown>>): unknown[] {
  return content.map((block) => ({ type: "assistant", message: { id, role: "assistant", content: [block] } }));
}
function reads(id: string, path: string): Record<string, unknown> {
  return { type: "tool_use", id, name: "mcp__rev__read_file", input: { path } };
}
function answers(id: string, findings: unknown[]): Record<string, unknown> {
  return { type: "tool_use", id, name: "StructuredOutput", input: { findings } };
}
function returned(id: string, content: unknown): unknown {
  return { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } };
}
const thinking = { type: "thinking", thinking: "private reasoning", signature: "sig" };
const fileText = [{ type: "text", text: '{"ok":true,"content":"1: line"}' }];

/** The same things as they appear in a transcript. */
function called(content: string | null, ...calls: Array<[id: string, name: string, args: unknown]>): ChatMessage {
  return { role: "assistant", content, tool_calls: calls.map(([id, name, args]) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } })) };
}
function result(id: string, content: string): ChatMessage {
  return { role: "tool", tool_call_id: id, content };
}

/** The value that follows a flag. */
function flag(call: Call, name: string): string | undefined {
  const index = call.args.indexOf(name);
  return index < 0 ? undefined : call.args[index + 1];
}

const lookAgain: SecondLook = {
  message: (round) => (round === 1 ? "look again" : null),
  combine: (submissions) => ({ findings: submissions.flatMap((submission) => submission.findings as unknown[]) }),
};

type Transcript = Array<{ caller: string; model: string; messages: ChatMessage[] }>;

interface Overrides {
  transcript?: Transcript;
  prompt?: string;
  deadline?: number;
  wrapUpMs?: number;
  maxTurns?: number;
  secondLook?: SecondLook;
  usage?: Usage;
  usageByCaller?: Map<string, Usage>;
}

function run(command: string, overrides: Overrides = {}, logs: string[] = []) {
  const { usage, usageByCaller, transcript, ...rest } = overrides;
  return runAgent({
    chat: claudeCodeChat({
      effort: "high", command, ...(usage ? { usage } : {}), ...(usageByCaller ? { usageByCaller } : {}),
      ...(transcript ? { transcript: (caller: string, model: string, messages: ChatMessage[]) => void transcript.push({ caller, model, messages }) } : {}),
    }),
    model: "anthropic/claude-opus-5.5", system: "system", prompt: "prompt", workspace, submit: submitReview,
    deadline: Date.now() + 3_600_000, maxTurns: 10, caller: "s1", log: (message) => logs.push(message), ...rest,
  });
}

test("model names are turned into the ones claude takes", () => {
  assert.equal(claudeModel("anthropic/claude-opus-5.5"), "claude-opus-5-5");
  assert.equal(claudeModel("claude-haiku-5-5"), "claude-haiku-5-5");
  assert.equal(claudeModel("opus"), "opus");
});

test("the chat marks the run for Claude Code", () => {
  assert.deepEqual(claudeCodeSettings(claudeCodeChat({ effort: null })), { effort: null });
  assert.equal(claudeCodeSettings(async () => ({ role: "assistant" })), null);
});

test("a direct call is one claude run with no tools, answered as a call to the submit tool", async () => {
  const claude = fake([done([{ file: "a.ts" }], 2, [...said("m1", thinking, answers("t1", [{ file: "a.ts" }])), returned("t1", "Structured output provided successfully")])]);
  const usageByCaller = new Map<string, Usage>();
  const transcript: Transcript = [];
  const chat = claudeCodeChat({ effort: "high", command: claude.command, usageByCaller, transcript: (caller, model, messages) => void transcript.push({ caller, model, messages }) });
  const asked: ChatMessage[] = [{ role: "system", content: "Report problems by calling submit_review." }, { role: "user", content: "the diff" }];
  const reply = await chat({ model: "anthropic/claude-opus-5.5", messages: asked, tools: [submitReview], timeoutMs: 60_000, caller: "naive", effort: "low" });

  assert.deepEqual(reply, called(null, ["structured_output", "submit_review", { findings: [{ file: "a.ts" }] }]));
  const [call, ...more] = claude.calls();
  assert.equal(more.length, 0);
  assert.equal(call!.stdin, "the diff");
  assert.equal(flag(call!, "--tools"), "");
  assert.ok(call!.args.includes("--strict-mcp-config"));
  assert.equal(flag(call!, "--mcp-config"), undefined);
  assert.equal(flag(call!, "--allowedTools"), undefined);
  assert.equal(flag(call!, "--effort"), "low");
  assert.equal(flag(call!, "--max-turns"), "3");
  assert.match(flag(call!, "--system-prompt")!, /^Report problems by calling submit_review\.\n\n## Answering in this session\n\n.*structured output/);
  assert.doesNotMatch(flag(call!, "--system-prompt")!, /mcp__/);
  assert.deepEqual(JSON.parse(flag(call!, "--json-schema")!), submitReview.function.parameters);
  assert.equal(usageByCaller.get("naive")!.costUsd, 0.25);
  assert.deepEqual(transcript, [{
    caller: "naive", model: "anthropic/claude-opus-5.5",
    messages: [...asked, called(null, ["t1", "submit_review", { findings: [{ file: "a.ts" }] }]), result("t1", "Structured output provided successfully")],
  }]);
});

test("a direct call must start a conversation and offer only the tool to answer with", async () => {
  const chat = claudeCodeChat({ effort: null, command: fake([]).command });
  const request = { model: "opus", messages: [{ role: "user" as const, content: "question" }], tools: [submitReview], timeoutMs: 60_000 };
  await assert.rejects(chat({ ...request, tools: [...readTools, submitReview] }), /offers one tool to answer with/);
  await assert.rejects(chat({ ...request, tools: [] }), /offers one tool to answer with/);
  await assert.rejects(chat({ ...request, messages: [...request.messages, { role: "assistant", content: "earlier" }] }), /starts a conversation/);
  await assert.rejects(chat(request), /claude exited with code 1: script ran out/);
});

test("the naive baseline runs on the engine", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rev-naive-"));
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  writeFileSync(join(dir, "diff.patch"), ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1 +1,2 @@", " export const a = 1;", "+export const b = 2;", ""].join("\n"));
  const config = loadConfig({
    RB_NWO: "owner/repo", RB_PR_NUMBER: "1", RB_BASE: "a".repeat(40), RB_HEAD: "b".repeat(40), RB_OUT: join(dir, "out", "findings.json"),
    RB_REPO: dir, RB_DIFF: join(dir, "diff.patch"), RB_PR_JSON: join(dir, "missing.json"),
    RB_CONFIG_ENGINE: "claude-code", RB_CONFIG_MODEL: "opus", RB_CONFIG_NAIVE: "on", CLAUDE_CODE_OAUTH_TOKEN: "token",
  });
  const finding = { file: "a.ts", start_line: 2, end_line: 2, severity: "low", kind: "maintainability", title: "Unused", detail: "b is never read." };
  const claude = fake([done([finding], 2)]);
  const outcome = await naiveReview(config, claudeCodeChat({ effort: config.effort, command: claude.command }), () => {});

  assert.equal(outcome.findings.length, 1);
  assert.equal(outcome.findings[0]!.file, "a.ts");
  const [call, ...more] = claude.calls();
  assert.equal(more.length, 0);
  assert.match(call!.stdin, /<diff>[\s\S]*export const b = 2;/);
  assert.equal(flag(call!, "--model"), "opus");
});

test("a missing claude is reported as a build problem", async () => {
  assert.match(String(await claudeCodeProblem(join(tmpdir(), "no-such-claude"))), /not installed.*CLAUDE_CODE_VERSION/);
  assert.equal(await claudeCodeProblem(process.execPath), null);
  await assert.rejects(run(join(tmpdir(), "no-such-claude")), /not installed/);
});

test("the claude CLI login is read from claude auth status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rev-fake-auth-"));
  const status = (name: string, body: string): string => {
    const command = join(dir, name);
    writeFileSync(command, `#!/usr/bin/env node\n${body}\n`);
    chmodSync(command, 0o755);
    return command;
  };
  assert.equal(await claudeLoginProblem(status("in.mjs", `console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }))`)), null);
  assert.match(String(await claudeLoginProblem(status("out.mjs", `console.log(JSON.stringify({ loggedIn: false, authMethod: "none" }))`))), /not signed in.*claude auth login/);
  assert.match(String(await claudeLoginProblem(status("fails.mjs", "process.exit(1)"))), /not signed in/);
  // Older versions print text: a successful exit means signed in, a failing one does not.
  assert.equal(await claudeLoginProblem(status("text.mjs", `console.log("Logged in as someone")`)), null);
  assert.match(String(await claudeLoginProblem(status("text-fails.mjs", `console.log("Not logged in"); process.exit(1)`))), /not signed in/);
  assert.match(String(await claudeLoginProblem(join(dir, "missing"))), /not signed in/);
});

test("a direct call claude cannot answer goes to the fallback model", async () => {
  const sent: ChatRequest[] = [];
  const fallback = async (request: ChatRequest): Promise<ChatMessage> => {
    sent.push(request);
    return called(null, ["f1", "submit_review", { findings: [] }]);
  };
  const logs: string[] = [];
  const chat = claudeCodeChat({ effort: null, command: fake([{ exit: 1, stderr: "Invalid API key" }]).command, fallback: { chat: fallback, model: "vendor/fallback" } }, (message) => logs.push(message));
  const reply = await chat({ model: "opus", messages: [{ role: "user", content: "the diff" }], tools: [submitReview], timeoutMs: 60_000, caller: "naive" });
  assert.deepEqual(reply, called(null, ["f1", "submit_review", { findings: [] }]));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.model, "vendor/fallback");
  // Only the time the call had left goes to the fallback.
  assert.ok(sent[0]!.timeoutMs <= 60_000 && sent[0]!.timeoutMs > 50_000, String(sent[0]!.timeoutMs));
  assert.match(logs.join("\n"), /naive: claude failed .*Invalid API key.*falling back to vendor\/fallback/);

  // With too little time left, the claude error stands.
  const late = claudeCodeChat({ effort: null, command: fake([{ exit: 1, stderr: "Invalid API key" }]).command, fallback: { chat: fallback, model: "vendor/fallback" } });
  await assert.rejects(late({ model: "opus", messages: [{ role: "user", content: "the diff" }], tools: [submitReview], timeoutMs: 9_000 }), /Invalid API key/);
  assert.equal(sent.length, 1);
});

test("a pass claude cannot finish starts over on the fallback model", async () => {
  const sent: ChatRequest[] = [];
  const fallback = async (request: ChatRequest): Promise<ChatMessage> => {
    sent.push(request);
    return called(null, ["f1", "submit_review", { findings: [{ file: "b.ts" }] }]);
  };
  const logs: string[] = [];
  const claude = fake([{ exit: 1, stderr: "Invalid API key" }]);
  const submitted = await runAgent({
    chat: claudeCodeChat({ effort: "high", command: claude.command, fallback: { chat: fallback, model: "vendor/fallback" } }),
    model: "opus", system: "system", prompt: "prompt", workspace, submit: submitReview,
    deadline: Date.now() + 3_600_000, maxTurns: 10, caller: "s1", log: (message) => logs.push(message),
  });
  assert.deepEqual(submitted, { findings: [{ file: "b.ts" }] });
  assert.equal(claude.calls().length, 1);
  assert.equal(sent[0]!.model, "vendor/fallback");
  assert.equal(sent[0]!.caller, "s1");
  // Claude failed before taking a turn, so the fallback has the whole budget.
  assert.match(logs.join("\n"), /s1: claude failed .*falling back to vendor\/fallback with 10 turn\(s\) left/);
});

test("a pass that falls back keeps the turns claude was not seen to use", async () => {
  const fallback = async (): Promise<ChatMessage> => called(null, ["f1", "submit_review", { findings: [] }]);
  const logs: string[] = [];
  // Claude reads twice, then fails: two turns taken of 10.
  const events = [...said("m1", reads("t1", "a.ts")), returned("t1", fileText), ...said("m2", reads("t2", "a.ts")), returned("t2", fileText)];
  const claude = fake([{ events, exit: 1, stderr: "Invalid API key" }]);
  await runAgent({
    chat: claudeCodeChat({ effort: null, command: claude.command, fallback: { chat: fallback, model: "vendor/fallback" } }),
    model: "opus", system: "system", prompt: "prompt", workspace, submit: submitReview,
    deadline: Date.now() + 3_600_000, maxTurns: 10, caller: "s1", log: (message) => logs.push(message),
  });
  assert.match(logs.join("\n"), /falling back to vendor\/fallback with 8 turn\(s\) left/);
});

test("a pass stopped at the size limit charges its whole allowance before falling back", async () => {
  const fallback = async (): Promise<ChatMessage> => called(null, ["f1", "submit_review", { findings: [] }]);
  const logs: string[] = [];
  // The investigation passes the conversation size limit and is stopped, so its totals are never printed;
  // the request for its answer then fails.
  const big = { type: "text", text: "x".repeat(MAX_CONTEXT_CHARS + 1) };
  const claude = fake([{ events: said("m1", big), hang: true }, { exit: 1, stderr: "Invalid API key" }]);
  await runAgent({
    chat: claudeCodeChat({ effort: null, command: claude.command, fallback: { chat: fallback, model: "vendor/fallback" } }),
    model: "opus", system: "system", prompt: "prompt", workspace, submit: submitReview,
    deadline: Date.now() + 3_600_000, maxTurns: 10, caller: "s1", log: (message) => logs.push(message),
  });
  assert.equal(claude.calls().length, 2);
  // 7 turns were allowed for the investigation, all charged; the 3 kept for the answer are left.
  assert.match(logs.join("\n"), /falling back to vendor\/fallback with 3 turn\(s\) left/);
});

test("a pass claude cannot finish for a passing reason, such as an overload, also falls back", async () => {
  const sent: ChatRequest[] = [];
  const fallback = async (request: ChatRequest): Promise<ChatMessage> => {
    sent.push(request);
    return called(null, ["f1", "submit_review", { findings: [] }]);
  };
  const logs: string[] = [];
  // The investigation and then the request for its answer both fail.
  const claude = fake([{ exit: 1, stderr: "API Error: 529 Overloaded" }, { exit: 1, stderr: "API Error: 529 Overloaded" }]);
  const submitted = await runAgent({
    chat: claudeCodeChat({ effort: null, command: claude.command, fallback: { chat: fallback, model: "vendor/fallback" } }),
    model: "opus", system: "system", prompt: "prompt", workspace, submit: submitReview,
    deadline: Date.now() + 3_600_000, maxTurns: 10, caller: "s1", log: (message) => logs.push(message),
  });
  assert.deepEqual(submitted, { findings: [] });
  assert.equal(claude.calls().length, 2);
  assert.equal(sent.length, 1);
  assert.match(logs.join("\n"), /falling back to vendor\/fallback with 10 turn\(s\) left/);
});

test("a failed pass keeps claude's error without a fallback or the room to use one", async () => {
  const fallback = async (): Promise<ChatMessage> => assert.fail("the fallback must not be called");
  const pass = (command: string, overrides: { fallback?: boolean; deadline?: number; maxTurns?: number } = {}) => runAgent({
    chat: claudeCodeChat({ effort: null, command, ...(overrides.fallback === false ? {} : { fallback: { chat: fallback, model: "vendor/fallback" } }) }),
    model: "opus", system: "system", prompt: "prompt", workspace, submit: submitReview,
    deadline: overrides.deadline ?? Date.now() + 3_600_000, maxTurns: overrides.maxTurns ?? 10, caller: "s1", log: () => {},
  });
  const failing = () => fake([{ exit: 1, stderr: "Invalid API key" }]).command;
  const claudeError = (error: unknown) => error instanceof Error && !/fallback must not be called/.test(error.message);
  await assert.rejects(pass(failing(), { fallback: false }), /Invalid API key/);
  // Less time left than the wrap-up needs.
  await assert.rejects(pass(failing(), { deadline: Date.now() + 60_000 }), claudeError);
  // A claude that used all but one of its turns before failing leaves too few for the fallback.
  const spent = fake([{ events: said("m1", reads("t1", "a.ts")).concat([returned("t1", fileText)], said("m2", reads("t2", "a.ts")), [returned("t2", fileText)]), exit: 1, stderr: "Invalid API key" }]).command;
  await assert.rejects(pass(spent, { maxTurns: 3 }), claudeError);
});

test("the tool server lists the read tools and runs calls in the workspace", async () => {
  const logs: string[] = [];
  const server = await serveTools({ workspace, log: (message) => logs.push(message) }, "s1");
  const post = (payload: unknown, url = server.url) => fetch(url, { method: "POST", body: typeof payload === "string" ? payload : JSON.stringify(payload) });
  try {
    const started = await (await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })).json() as any;
    assert.equal(started.result.protocolVersion, "2025-03-26");
    assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);

    const listed = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json() as any;
    assert.deepEqual(listed.result.tools.map((tool: { name: string }) => tool.name), readTools.map((tool) => tool.function.name));
    assert.ok(listed.result.tools.every((tool: { inputSchema?: unknown }) => tool.inputSchema));

    const called = await (await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_file", arguments: { path: "src/a.ts" } } })).json() as any;
    assert.deepEqual(JSON.parse(called.result.content[0].text), { ok: true, tool: "read_file", args: { path: "src/a.ts" } });
    assert.deepEqual(logs, ["s1: read_file src/a.ts"]);

    const unknown = await (await post({ jsonrpc: "2.0", id: 4, method: "resources/list" })).json() as any;
    assert.equal(unknown.error.code, -32601);

    // Only a POST to the secret path is served, and a body that is not a JSON object is refused.
    assert.equal((await post({ jsonrpc: "2.0", id: 5, method: "tools/list" }, server.url.replace(/[^/]+$/, "guess"))).status, 404);
    assert.equal((await fetch(server.url)).status, 405);
    assert.equal((await post("not json")).status, 400);
    assert.equal((await post("null")).status, 400);
  } finally {
    server.close();
  }
});

test("a pass sends its prompt on standard input and returns the structured output", async () => {
  const claude = fake([done([{ file: "a.ts" }])]);
  const usage = emptyUsage();
  const usageByCaller = new Map<string, Usage>();
  // Larger than the 128 KiB Linux allows one command-line argument.
  const prompt = "x".repeat(200_000);
  assert.deepEqual(await run(claude.command, { prompt, usage, usageByCaller }), { findings: [{ file: "a.ts" }] });

  const [call, ...more] = claude.calls();
  assert.equal(more.length, 0);
  assert.equal(call!.stdin, prompt);
  assert.ok(call!.args.every((value) => value.length < 20_000));
  assert.equal(flag(call!, "--output-format"), "stream-json");
  assert.ok(call!.args.includes("--verbose"));
  assert.equal(flag(call!, "--model"), "claude-opus-5-5");
  assert.equal(flag(call!, "--tools"), "");
  assert.equal(flag(call!, "--setting-sources"), "");
  assert.equal(flag(call!, "--effort"), "high");
  assert.equal(flag(call!, "--max-turns"), "7");
  assert.match(flag(call!, "--session-id")!, /^[0-9a-f-]{36}$/);
  assert.match(flag(call!, "--system-prompt")!, /^system\n\n## Tools in this session[\s\S]*mcp__rev__read_file[\s\S]*submit_review/);
  assert.deepEqual(JSON.parse(flag(call!, "--json-schema")!), submitReview.function.parameters);
  assert.match(JSON.parse(flag(call!, "--mcp-config")!).mcpServers.rev.url, /^http:\/\/127\.0\.0\.1:\d+\//);

  // Cached and newly cached tokens count as prompt tokens, as they do for the chat API.
  const spent = { calls: 4, promptTokens: 400, completionTokens: 50, cachedTokens: 300, costUsd: 0.25 };
  assert.deepEqual(usage, spent);
  assert.deepEqual(usageByCaller.get("s1"), spent);
});

test("a character that arrives in two pieces is read whole", async () => {
  const finding = { file: "café.ts", title: "naïve → wrong" };
  const claude = fake([{ ...done([finding]), splitCharacters: true }]);
  assert.deepEqual(await run(claude.command), { findings: [finding] });
});

test("a reviewer that runs out of turns is asked for its answer, and not asked to look again", async () => {
  const claude = fake([outOfTurns, done([{ file: "a.ts" }], 2)]);
  assert.deepEqual(await run(claude.command, { secondLook: lookAgain }), { findings: [{ file: "a.ts" }] });

  const [first, second, ...more] = claude.calls();
  assert.equal(more.length, 0);
  assert.equal(flag(second!, "--resume"), flag(first!, "--session-id"));
  assert.equal(flag(second!, "--max-turns"), "3");
  assert.equal(flag(second!, "--system-prompt"), flag(first!, "--system-prompt"));
  assert.match(second!.stdin, /^Stop investigating\. Give your submit_review answer as your structured output now/);
});

test("the second look resumes the session with the turns that are left", async () => {
  const claude = fake([done([{ file: "a.ts" }], 4), done([{ file: "b.ts" }], 3)]);
  assert.deepEqual(await run(claude.command, { secondLook: lookAgain }), { findings: [{ file: "a.ts" }, { file: "b.ts" }] });

  const [first, second, ...more] = claude.calls();
  assert.equal(more.length, 0);
  assert.equal(flag(second!, "--resume"), flag(first!, "--session-id"));
  assert.equal(flag(second!, "--max-turns"), "3");
  assert.equal(second!.stdin, "look again");
});

test("a failed second look keeps the first submission", async () => {
  const claude = fake([done([{ file: "a.ts" }]), { exit: 1, stderr: "API Error: overloaded" }]);
  const logs: string[] = [];
  assert.deepEqual(await run(claude.command, { secondLook: lookAgain }, logs), { findings: [{ file: "a.ts" }] });
  assert.ok(logs.some((line) => /investigation failed.*overloaded/.test(line)));
  assert.ok(logs.some((line) => /a later round failed/.test(line)));
});

test("a pass with no answer fails", async () => {
  await assert.rejects(run(fake([{ exit: 1, stderr: "Invalid API key" }]).command), /claude exited with code 1: Invalid API key/);
  await assert.rejects(run(fake([{ result: { type: "result", subtype: "success", is_error: false, result: "prose" } }]).command), /returned no submit_review output/);
});

test("the transcript holds each pass's conversation in the chat format", async () => {
  const claude = fake([
    // One response reads two files. Claude prints the first call's result before the second call.
    done([{ file: "a.ts" }], 4, [
      { type: "system", subtype: "init", tools: ["mcp__rev__read_file"] },
      ...said("m1", thinking, { type: "text", text: "Reading both." }, reads("t1", "a.ts")),
      returned("t1", fileText),
      ...said("m1", reads("t2", "b.ts")),
      returned("t2", fileText),
      { type: "rate_limit_event" },
      ...said("m2", thinking, answers("t3", [{ file: "a.ts" }])),
      returned("t3", "Structured output provided successfully"),
    ]),
    // In the second look the model answers in prose first, and Claude Code reminds it to give the structured output.
    done([], 3, [
      ...said("m3", { type: "text", text: "Nothing more." }),
      { type: "user", isSynthetic: true, message: { role: "user", content: [{ type: "text", text: "You must give the structured output." }] } },
      ...said("m4", answers("t4", [])),
      returned("t4", "Structured output provided successfully"),
    ]),
  ]);
  const transcript: Transcript = [];
  await run(claude.command, { secondLook: lookAgain, transcript });

  assert.equal(transcript.length, 1);
  assert.equal(transcript[0]!.caller, "s1");
  assert.equal(transcript[0]!.model, "anthropic/claude-opus-5.5");
  assert.deepEqual(transcript[0]!.messages, [
    { role: "system", content: "system" },
    { role: "user", content: "prompt" },
    called("Reading both.", ["t1", "read_file", { path: "a.ts" }], ["t2", "read_file", { path: "b.ts" }]),
    result("t1", '{"ok":true,"content":"1: line"}'),
    result("t2", '{"ok":true,"content":"1: line"}'),
    called(null, ["t3", "submit_review", { findings: [{ file: "a.ts" }] }]),
    result("t3", "Structured output provided successfully"),
    { role: "user", content: "look again" },
    { role: "assistant", content: "Nothing more." },
    { role: "user", content: "You must give the structured output." },
    called(null, ["t4", "submit_review", { findings: [] }]),
    result("t4", "Structured output provided successfully"),
  ]);
});

test("the transcript keeps what a stopped run read", async () => {
  const claude = fake([
    { hang: true, events: [...said("m1", reads("t1", "a.ts")), returned("t1", fileText), ...said("m2", reads("t2", "b.ts"))] },
    done([{ file: "a.ts" }], 2, [...said("m3", answers("t3", [{ file: "a.ts" }])), returned("t3", "Structured output provided successfully")]),
  ]);
  const transcript: Transcript = [];
  await run(claude.command, { deadline: Date.now() + 6_000, wrapUpMs: 5_000, transcript });

  const messages = transcript[0]!.messages;
  assert.deepEqual(messages.slice(0, 6), [
    { role: "system", content: "system" },
    { role: "user", content: "prompt" },
    called(null, ["t1", "read_file", { path: "a.ts" }]),
    result("t1", '{"ok":true,"content":"1: line"}'),
    called(null, ["t2", "read_file", { path: "b.ts" }]),
    result("t2", "The run was stopped before this call returned."),
  ]);
  assert.match(String(messages[6]!.content), /^Stop investigating/);
  assert.deepEqual(messages.slice(7), [called(null, ["t3", "submit_review", { findings: [{ file: "a.ts" }] }]), result("t3", "Structured output provided successfully")]);
});

test("an investigation that grows past the conversation size limit is stopped and asked for its answer", { timeout: 30_000 }, async () => {
  // The chat loop's limit is 800,000 characters. Nothing else stops this run: the deadline is an hour away.
  const large = [{ type: "text", text: "x".repeat(900_000) }];
  const claude = fake([
    { hang: true, events: [...said("m1", reads("t1", "a.ts")), returned("t1", large)] },
    done([{ file: "a.ts" }], 2),
  ]);
  const logs: string[] = [];
  assert.deepEqual(await run(claude.command, { secondLook: lookAgain }, logs), { findings: [{ file: "a.ts" }] });

  const [first, second, ...more] = claude.calls();
  assert.equal(more.length, 0);
  assert.equal(flag(second!, "--resume"), flag(first!, "--session-id"));
  assert.match(second!.stdin, /^Stop investigating/);
  assert.ok(logs.some((line) => line.includes("stopped at the conversation size limit")), logs.join("\n"));
});

test("an investigation that runs into the wrap-up time is stopped and asked for its answer", async () => {
  const claude = fake([{ hang: true }, done([{ file: "a.ts" }], 2)]);
  const logs: string[] = [];
  assert.deepEqual(await run(claude.command, { deadline: Date.now() + 6_000, wrapUpMs: 5_000 }, logs), { findings: [{ file: "a.ts" }] });

  const [first, second, ...more] = claude.calls();
  assert.equal(more.length, 0);
  assert.equal(flag(second!, "--resume"), flag(first!, "--session-id"));
  assert.match(second!.stdin, /^Stop investigating/);
  assert.ok(logs.some((line) => line.includes("stopped to keep time for the answer")));
});

test("a claude that ignores the stop signal is killed", { timeout: 30_000 }, async () => {
  // The context limit triggers only after the fake has installed its signal handler.
  const claude = fake([{ hang: true, ignoreStop: true, events: said("m1", { type: "text", text: "x".repeat(900_000) }) }, done([], 2)]);
  assert.deepEqual(await run(claude.command, { wrapUpMs: 4_000 }), { findings: [] });
  assert.equal(readFileSync(join(claude.command, "..", "signals"), "utf8"), "SIGTERM");
  assert.equal(claude.calls().length, 2);
});

test("a stopped run that cannot be resumed is asked again in a new session", async () => {
  const claude = fake([
    { hang: true, events: said("m1", reads("t1", "a.ts")) },
    { exit: 1, stderr: "No conversation found with session ID" },
    done([{ file: "a.ts" }], 2),
  ]);
  const transcript: Transcript = [];
  assert.deepEqual(await run(claude.command, { deadline: Date.now() + 6_000, wrapUpMs: 5_000, transcript }), { findings: [{ file: "a.ts" }] });

  const [first, , third] = claude.calls();
  assert.notEqual(flag(third!, "--session-id"), flag(first!, "--session-id"));
  assert.match(flag(third!, "--system-prompt")!, /^system/);
  assert.equal(flag(third!, "--max-turns"), "3");
  assert.match(third!.stdin, /^prompt\n\nStop investigating/);
  // The new session never saw the stopped one, so the transcript starts over with it.
  assert.deepEqual(transcript[0]!.messages, [{ role: "system", content: "system" }, { role: "user", content: third!.stdin }]);
});

test("with no time left to investigate, the first call asks for the answer", async () => {
  const claude = fake([done([{ file: "a.ts" }], 2)]);
  assert.deepEqual(await run(claude.command, { deadline: Date.now() + 4_000, wrapUpMs: 5_000 }), { findings: [{ file: "a.ts" }] });

  const [call, ...more] = claude.calls();
  assert.equal(more.length, 0);
  assert.equal(flag(call!, "--max-turns"), "3");
  assert.match(flag(call!, "--session-id")!, /^[0-9a-f-]{36}$/);
  assert.match(call!.stdin, /^prompt\n\nStop investigating/);
});

test("a small turn budget goes straight to the answer without exceeding it", async () => {
  const claude = fake([done([], 2)]);
  await run(claude.command, { maxTurns: 2, secondLook: lookAgain });
  assert.deepEqual(claude.calls().map((call) => flag(call, "--max-turns")), ["2"]);
  assert.match(claude.calls()[0]!.stdin, /Stop investigating/);
});

test("interrupted usage counts each message once and leaves cost unknown", { timeout: 30_000 }, async () => {
  const partial = { type: "assistant", message: { id: "m1", usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 20 }, content: [{ type: "text", text: "x".repeat(450_000) }] } };
  const claude = fake([{ hang: true, events: [partial, partial] }, done([], 2)]);
  const usage = emptyUsage();
  const usageByCaller = new Map<string, Usage>();
  await run(claude.command, { usage, usageByCaller });
  assert.deepEqual(usage, { calls: 3, promptTokens: 520, completionTokens: 80, cachedTokens: 320, costUsd: null });
  assert.deepEqual(usageByCaller.get("s1"), usage);
  assert.deepEqual(claude.calls().map((call) => flag(call, "--max-turns")), ["7", "3"]);
});

test("a transient failed process retains usage and resumes for its answer", async () => {
  const claude = fake([{ exit: 1, stderr: "API Error: overloaded", events: [{ type: "assistant", message: { id: "m1", content: [], usage: { input_tokens: 100, output_tokens: 30 } } }] }, done([], 2)]);
  const usage = emptyUsage();
  assert.deepEqual(await run(claude.command, { usage }), { findings: [] });
  assert.equal(usage.promptTokens, 500);
  assert.equal(usage.completionTokens, 80);
  assert.equal(usage.costUsd, null);
  assert.equal(flag(claude.calls()[1]!, "--resume"), flag(claude.calls()[0]!, "--session-id"));
});

test("a transient error result can be recovered without losing its final totals", async () => {
  const claude = fake([{ result: { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 2, total_cost_usd: 0.1, permission_denials: [], errors: ["API Error: 503 temporarily unavailable"] } }, done([], 2)]);
  const usage = emptyUsage();
  assert.deepEqual(await run(claude.command, { usage }), { findings: [] });
  assert.equal(usage.costUsd, 0.35);
});

test("final usage replaces streamed usage instead of counting both", async () => {
  const claude = fake([done([], 2, [{ type: "assistant", message: { id: "m1", usage: { input_tokens: 1000 }, content: [] } }])]);
  const usage = emptyUsage();
  await run(claude.command, { usage });
  assert.equal(usage.promptTokens, 400);
  assert.equal(usage.costUsd, 0.25);
});


test("a temporary-directory failure does not open a tool server", async () => {
  const before = process.getActiveResourcesInfo().filter((name) => name === "TCPServerWrap").length;
  const command = fake([]).command;
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = join(tmpdir(), "no-such-parent", "tmp");
  try {
    await assert.rejects(run(command), /ENOENT/);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
  assert.equal(process.getActiveResourcesInfo().filter((name) => name === "TCPServerWrap").length, before);
});

test("the entry point writes each fix alongside its finding and omits missing fixes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rev-details-"));
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  writeFileSync(join(dir, "diff.patch"), "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+export const a = 1;\n+export const b = 2;\n");
  const findings = [1, 2].map((line) => ({ file: "a.ts", start_line: line, end_line: line, severity: "low", kind: "maintainability", title: line === 1 ? "Unused constant" : "Incorrect assignment", detail: line === 1 ? "The exported value is never consumed." : "The assignment must reference its dependency." }));
  const claude = fake([done(findings, 2), { result: { type: "result", subtype: "success", num_turns: 2, structured_output: { fixes: [{ id: "F2", start_line: 2, end_line: 2, replacement: "export const b = a + 1;" }] } } }]);
  symlinkSync(claude.command, join(dir, "claude"));
  await promisify(execFile)(process.execPath, [join(import.meta.dirname, "../src/main.ts")], { timeout: 30_000, env: {
    PATH: `${dir}:${process.env.PATH}`, HOME: dir, RB_NWO: "fixture/repo", RB_PR_NUMBER: "1", RB_BASE: "a".repeat(40), RB_HEAD: "b".repeat(40),
    RB_REPO: dir, RB_DIFF: join(dir, "diff.patch"), RB_PR_JSON: join(dir, "missing.json"), RB_OUT: join(dir, "findings.json"), RB_DETAILS_OUT: join(dir, "details.json"),
    RB_CONFIG_ENGINE: "claude-code", RB_CONFIG_MODEL: "opus", CLAUDE_CODE_OAUTH_TOKEN: "fixture-only", RB_CONFIG_FIXES: "opus", RB_CONFIG_SECOND_LOOK: "off", RB_CONFIG_VERIFY: "off", RB_CONFIG_RETRY_EMPTY: "off",
  } });
  const details = JSON.parse(readFileSync(join(dir, "details.json"), "utf8"));
  assert.equal(details.findings.length, 2);
  assert.equal(details.findings[0].title, "Unused constant");
  assert.equal(Object.hasOwn(details.findings[0], "fix"), false);
  assert.equal(details.findings[1].title, "Incorrect assignment");
  assert.deepEqual(details.findings[1].fix, { start_line: 2, end_line: 2, replacement: "export const b = a + 1;" });
});
