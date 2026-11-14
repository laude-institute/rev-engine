// Runs a review pass in Claude Code (`claude -p`) instead of through the chat
// API, so a Claude Code login (CLAUDE_CODE_OAUTH_TOKEN) can drive the review.
//
// Claude Code runs the tool loop. It gets none of its own tools: it reads the
// checkout only through this reviewer's read tools, served to it over MCP from
// this process, so the same confinement and read tracking apply. The submit
// tool becomes Claude Code's structured output.
//
// Prompts reach claude on its standard input. Linux limits one command-line
// argument to 128 KiB, and a review prompt can be larger. Claude prints every
// message of the conversation as it happens, which is kept for the transcript.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_CONTEXT_CHARS, WRAP_UP_MS, label, type AgentOptions } from "./agent.ts";
import { addCosts, emptyUsage, formatCost, type Chat, type ChatMessage, type ChatRequest, type Usage } from "./llm.ts";
import { NOT_INSTALLED } from "./claude-cli.ts";
import { readTools, type ToolDefinition } from "./tools.ts";

export { claudeCodeProblem, claudeLoginProblem } from "./claude-cli.ts";

const SERVER = "rev";
const SETTINGS = Symbol("claude-code");
/** How long a claude that was told to stop gets to exit before it is killed. */
const KILL_GRACE_MS = 5_000;
/** A fallback with less time than this left is not started. */
export const MIN_FALLBACK_MS = 10_000;
/** Turns allowed when only the answer is asked for. */
const ANSWER_TURNS = 3;

export interface ClaudeCodeSettings {
  effort: string | null;
  /** Totals for the run, and for each caller, that every claude call is added to. */
  usage?: Usage;
  usageByCaller?: Map<string, Usage>;
  /** Given each pass's conversation when the pass starts. The list grows as the pass runs. */
  transcript?: (caller: string, model: string, messages: ChatMessage[]) => void;
  /** The program to run in place of claude, for tests. */
  command?: string;
  /**
   * Takes over a pass, or a direct call, that claude could not finish: the same request,
   * sent through an OpenAI-compatible chat with this model in place of the Claude one.
   */
  fallback?: { chat: Chat; model: string };
}

/**
 * A Chat that marks the run for Claude Code. runAgent sees the mark and runs the whole
 * pass in Claude Code. A direct call, as the naive baseline makes, is one claude run.
 */
export function claudeCodeChat(settings: ClaudeCodeSettings, log: (message: string) => void = () => {}): Chat {
  const chat: Chat = async (request) => {
    const started = Date.now();
    try {
      return await askClaudeCode(request, settings);
    } catch (error) {
      // The fallback gets only the time the call had left, so falling back never overruns it.
      const timeoutMs = request.timeoutMs - (Date.now() - started);
      if (!settings.fallback || timeoutMs < MIN_FALLBACK_MS) throw error;
      log(`${request.caller ?? request.model}: claude failed (${error instanceof Error ? error.message : String(error)}); falling back to ${settings.fallback.model}`);
      return settings.fallback.chat({ ...request, model: settings.fallback.model, timeoutMs });
    }
  };
  return Object.assign(chat, { [SETTINGS]: settings });
}

export function claudeCodeSettings(chat: Chat): ClaudeCodeSettings | null {
  return (chat as Chat & { [SETTINGS]?: ClaudeCodeSettings })[SETTINGS] ?? null;
}

/** anthropic/claude-opus-5.5 becomes claude-opus-5-5; aliases such as opus pass through. */
export function claudeModel(model: string): string {
  return model.replace(/^anthropic\//, "").replace(/(\d)\.(\d)/g, "$1-$2");
}

/** Tells the model how this session differs from the one its instructions were written for. */
function sessionNote(submitName: string, withTools: boolean): string {
  const answer = `Where these instructions say to call ${submitName}, give that answer as your structured output instead.`;
  if (!withTools) return `\n\n## Answering in this session\n\n${answer}`;
  return `\n\n## Tools in this session\n\nYour tools are named mcp__${SERVER}__<name>. Where these instructions name a tool, such as read_file, use mcp__${SERVER}__read_file. ${answer}`;
}

/** The arguments every claude call shares. Claude gets none of its own tools, and only the MCP server named here, if any. */
function baseArgs(model: string, submit: ToolDefinition, effort: string | null, toolsUrl?: string): string[] {
  return [
    "-p", "--output-format", "stream-json", "--verbose",
    "--model", claudeModel(model),
    "--tools", "",
    "--strict-mcp-config",
    ...(toolsUrl ? ["--mcp-config", JSON.stringify({ mcpServers: { [SERVER]: { type: "http", url: toolsUrl } } }), "--allowedTools", `mcp__${SERVER}`] : []),
    "--setting-sources", "",
    "--json-schema", JSON.stringify(submit.function.parameters),
    ...(effort ? ["--effort", effort] : []),
  ];
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function reply(response: ServerResponse, status: number, value?: unknown): void {
  response.writeHead(status, value === undefined ? {} : { "content-type": "application/json" });
  response.end(value === undefined ? undefined : JSON.stringify(value));
}

/** A streamable-HTTP MCP server on a loopback port that answers with the workspace's read tools. */
export async function serveTools(options: Pick<AgentOptions, "workspace" | "log">, who: string): Promise<{ url: string; close: () => void }> {
  const path = `/${randomUUID()}`;
  const tools = readTools.map((tool) => ({ name: tool.function.name, description: tool.function.description, inputSchema: tool.function.parameters }));
  const server = createServer(async (request, response) => {
    if (request.url !== path) return reply(response, 404);
    if (request.method !== "POST") return reply(response, 405);
    let message: { id?: unknown; method?: string; params?: Record<string, unknown> } | null;
    try {
      message = JSON.parse(await body(request));
    } catch {
      return reply(response, 400);
    }
    if (!message || typeof message !== "object") return reply(response, 400);
    if (message.id === undefined) return reply(response, 202);
    const answer = (result: unknown) => reply(response, 200, { jsonrpc: "2.0", id: message.id, result });
    switch (message.method) {
      case "initialize":
        return answer({
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: SERVER, version: "1" },
        });
      case "ping":
        return answer({});
      case "tools/list":
        return answer({ tools });
      case "tools/call": {
        const name = String(message.params?.name ?? "");
        const args = JSON.stringify(message.params?.arguments ?? {});
        options.log(`${who}: ${label(name, args)}`);
        return answer({ content: [{ type: "text", text: await options.workspace.call(name, args) }] });
      }
      default:
        return reply(response, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}${path}`, close: () => server.close() };
}

interface Result {
  is_error?: boolean;
  subtype?: string;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  structured_output?: unknown;
  result?: string;
  errors?: string[];
}

interface Block {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

/** One line of claude's stream-json output: a message of the conversation, the final result, or a notice. */
interface StreamEvent {
  type?: string;
  message?: { id?: string; content?: unknown; usage?: Result["usage"] };
}

function blocks(content: unknown): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content.filter((block): block is Block => Boolean(block) && typeof block === "object") : [];
}

/** The characters an event adds to the conversation, counted as the chat loop counts its messages. */
function eventChars(event: StreamEvent): number {
  if (event.type !== "assistant" && event.type !== "user") return 0;
  const textChars = (content: unknown): number => blocks(content).reduce((sum, block) => sum + (block.text?.length ?? 0), 0);
  return blocks(event.message?.content).reduce((sum, block) => sum
    + (block.text?.length ?? 0)
    + (block.type === "tool_use" ? JSON.stringify(block.input ?? {}).length : 0)
    + (block.type === "tool_result" ? textChars(block.content) : 0), 0);
}

/**
 * Adds the messages of one claude call to a conversation in the chat format, so a
 * transcript reads the same from either engine: tools carry their own names, and the
 * structured output is a call to the submit tool. Reasoning is left out.
 *
 * Claude prints one event for each block of a response, and a response's tool calls
 * can be separated by their results, so blocks are joined by the response's ID.
 */
function transcribe(events: StreamEvent[], submitName: string, messages: ChatMessage[]): void {
  const replies = new Map<string, ChatMessage>();
  const unanswered = new Set<string>();
  for (const event of events) {
    const id = event.message?.id;
    for (const block of blocks(event.message?.content)) {
      if (event.type === "assistant" && (block.type === "text" || block.type === "tool_use")) {
        let reply = id ? replies.get(id) : undefined;
        if (!reply) {
          reply = { role: "assistant", content: null };
          if (id) replies.set(id, reply);
          messages.push(reply);
        }
        if (block.type === "text") reply.content = (reply.content ?? "") + (block.text ?? "");
        else {
          const name = block.name === "StructuredOutput" ? submitName : String(block.name ?? "").replace(`mcp__${SERVER}__`, "");
          (reply.tool_calls ??= []).push({ id: String(block.id), type: "function", function: { name, arguments: JSON.stringify(block.input ?? {}) } });
          unanswered.add(String(block.id));
        }
      } else if (event.type === "user" && block.type === "tool_result") {
        messages.push({ role: "tool", tool_call_id: String(block.tool_use_id), content: blocks(block.content).map((part) => part.text ?? "").join("") });
        unanswered.delete(String(block.tool_use_id));
      } else if (event.type === "user" && block.type === "text") {
        messages.push({ role: "user", content: block.text ?? "" });
      }
    }
  }
  // A run stopped in the middle of a tool call leaves it without a result, which the chat format does not allow.
  for (const id of unanswered) messages.push({ role: "tool", tool_call_id: id, content: "The run was stopped before this call returned." });
}

interface Run {
  /** Null when the run was stopped before it finished. */
  result: Result | null;
  events: StreamEvent[];
  error?: Error;
}

interface RunOptions {
  cwd: string;
  /** The run is stopped after this long. */
  timeoutMs: number;
  /** A claude that has not exited this long after it was stopped is killed. */
  graceMs: number;
  /** Called with each event as claude prints it. Returning true stops the run. */
  stopAt?: (event: StreamEvent) => boolean;
}

/** Runs claude with the prompt on its standard input, reading its events as they are printed. */
function runClaude(command: string, args: string[], prompt: string, options: RunOptions): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } });
    const events: StreamEvent[] = [];
    /** The end of the output so far, when it is not a whole line yet. */
    let unread = "";
    /** Output that is not an event, for the error message. */
    let other = "";
    let stderr = "";
    let stopped = false;
    let kill: NodeJS.Timeout | undefined;
    let drain: NodeJS.Timeout | undefined;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      child.kill("SIGTERM");
      kill = setTimeout(() => child.kill("SIGKILL"), options.graceMs);
    };
    const read = (line: string): void => {
      if (!line.trim()) return;
      let event: unknown = null;
      try {
        event = JSON.parse(line);
      } catch {
        // Not an event. A run that was stopped can also leave its last line cut off.
      }
      if (!event || typeof event !== "object") {
        if (other.length < 300) other += `${line}\n`;
        return;
      }
      events.push(event as StreamEvent);
      if (options.stopAt?.(event as StreamEvent)) stop();
    };
    // Decoded as one stream each, so a character split between two chunks is read whole.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const lines = (unread + chunk).split("\n");
      unread = lines.pop()!;
      for (const line of lines) read(line);
    });
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    // A claude that exits early closes the pipe. Its exit is reported below.
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
    const timer = setTimeout(stop, Math.max(options.timeoutMs, 0));
    const settle = (): void => {
      clearTimeout(timer);
      clearTimeout(kill);
      clearTimeout(drain);
    };
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      settle();
      read(unread);
      unread = "";
      const result = events.findLast((event) => event.type === "result") as Result | undefined;
      if (result) return resolve({ result, events });
      if (stopped) return resolve({ result: null, events });
      const error = new Error(signal ? `claude was stopped by ${signal}` : `claude exited with code ${code}: ${(stderr || other).trim().slice(0, 300)}`);
      resolve({ result: null, events, error });
    };
    child.on("error", (error) => {
      settle();
      reject((error as NodeJS.ErrnoException).code === "ENOENT" ? new Error(NOT_INSTALLED) : error);
    });
    // A stopped run's output only feeds the transcript, so it is not waited for long once claude has exited.
    child.on("exit", (code, signal) => {
      if (stopped) drain = setTimeout(() => finish(code, signal), 1_000);
    });
    child.on("close", finish);
  });
}

/** Recover the usage we observed when a process could not print its final totals.
 * Claude can emit several blocks of one message, so count each message only once.
 */
function observedUsage(events: StreamEvent[]): Result {
  const messages = new Map<string | StreamEvent, NonNullable<Result["usage"]>>();
  for (const event of events) {
    if (event.type !== "assistant") continue;
    const key = event.message?.id ?? event;
    const previous = messages.get(key) ?? {};
    for (const [name, value] of Object.entries(event.message?.usage ?? {})) {
      const field = name as keyof typeof previous;
      if (typeof value === "number" && Number.isFinite(value)) previous[field] = Math.max(previous[field] ?? 0, value);
    }
    messages.set(key, previous);
  }
  const usage: NonNullable<Result["usage"]> = {};
  for (const message of messages.values()) {
    for (const [name, value] of Object.entries(message)) {
      const field = name as keyof typeof usage;
      usage[field] = (usage[field] ?? 0) + value;
    }
  }
  return { num_turns: messages.size, usage };
}

/** Adds final totals, or observed partial usage with unknown cost, without counting both. */
function record(settings: ClaudeCodeSettings, caller: string | undefined, run: Run): void {
  const result = run.result ?? observedUsage(run.events);
  const totals = settings.usage ? [settings.usage] : [];
  if (caller && settings.usageByCaller) {
    if (!settings.usageByCaller.has(caller)) settings.usageByCaller.set(caller, emptyUsage());
    totals.push(settings.usageByCaller.get(caller)!);
  }
  const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  const cached = count(result.usage?.cache_read_input_tokens);
  for (const usage of totals) {
    usage.calls += count(result.num_turns);
    usage.promptTokens += count(result.usage?.input_tokens) + cached + count(result.usage?.cache_creation_input_tokens);
    usage.completionTokens += count(result.usage?.output_tokens);
    usage.cachedTokens += cached;
    usage.costUsd = addCosts(usage.costUsd, result.total_cost_usd ?? null);
  }
}

/** Setup failures cannot be repaired by asking the same model again. */
function recoverable(message: string): boolean {
  return /overload|rate.?limit|temporar|timeout|timed out|ECONN|fetch failed|\b50[0234]\b|\b529\b/i.test(message)
    && !/api.?key|authenticat|unauthorized|permission|invalid model/i.test(message);
}

/** The answer a finished run gave. */
function submissionOf(result: Result, who: string, submitName: string): Record<string, unknown> {
  const value = result.structured_output;
  if (result.is_error || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${who}: claude returned no ${submitName} output (${result.subtype ?? "error"}): ${String(result.result ?? "").slice(0, 300)}`);
  }
  return value as Record<string, unknown>;
}

/**
 * Answers one question in one claude run, with nothing to read. The request must be a
 * new conversation that offers only the tool to answer with, as the naive baseline's does.
 * That tool becomes the structured output, and the answer comes back as a call to it.
 */
async function askClaudeCode(request: ChatRequest, settings: ClaudeCodeSettings): Promise<ChatMessage> {
  const [submit, ...others] = request.tools;
  if (!submit || others.length || request.messages.some((message) => message.role !== "system" && message.role !== "user")) {
    throw new Error("the claude-code engine answers a direct call only when it starts a conversation and offers one tool to answer with");
  }
  const who = request.caller ?? request.model;
  const submitName = submit.function.name;
  const said = (role: string): string => request.messages.filter((message) => message.role === role).map((message) => message.content ?? "").join("\n\n");
  const messages = [...request.messages];
  settings.transcript?.(who, request.model, messages);
  // An empty directory, so Claude Code finds no CLAUDE.md or settings from the checkout.
  const cwd = await mkdtemp(join(tmpdir(), "rev-claude-"));
  try {
    const args = [
      ...baseArgs(request.model, submit, request.effort ?? settings.effort),
      "--max-turns", String(ANSWER_TURNS), "--system-prompt", said("system") + sessionNote(submitName, false),
    ];
    const run = await runClaude(settings.command ?? "claude", args, said("user"), { cwd, timeoutMs: request.timeoutMs - KILL_GRACE_MS, graceMs: KILL_GRACE_MS });
    const { result, events } = run;
    transcribe(events, submitName, messages);
    record(settings, request.caller, run);
    if (run.error) throw run.error;
    if (!result) throw new Error(`${who}: ran out of time before giving its ${submitName} answer`);
    const answer = JSON.stringify(submissionOf(result, who, submitName));
    return { role: "assistant", content: null, tool_calls: [{ id: "structured_output", type: "function", function: { name: submitName, arguments: answer } }] };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function describeRun(result: Result): string {
  return `${result.subtype ?? "done"} after ${result.num_turns ?? "?"} turn(s), ${formatCost(result.total_cost_usd ?? null, 4)} at API prices`;
}

export async function runClaudeCode(options: AgentOptions, settings: ClaudeCodeSettings): Promise<Record<string, unknown>> {
  const { model, submit, deadline, secondLook, log } = options;
  const who = options.caller ?? model;
  const wrapUpMs = options.wrapUpMs ?? WRAP_UP_MS;
  // The grace period comes out of the wrap-up time, so a claude that has to be killed still ends by the deadline.
  const graceMs = Math.min(KILL_GRACE_MS, wrapUpMs / 4);
  const submitName = submit.function.name;
  const system = options.system + sessionNote(submitName, true);
  const answerNow = `Stop investigating. Give your ${submitName} answer as your structured output now, with what you have established so far.`;
  let tools: Awaited<ReturnType<typeof serveTools>> | undefined;
  // An empty directory, so Claude Code finds no CLAUDE.md or settings from the checkout.
  const cwd = await mkdtemp(join(tmpdir(), "rev-claude-"));
  const submissions: Array<Record<string, unknown>> = [];
  // One turn budget for the whole conversation, as in the chat loop.
  let turnsLeft = options.maxTurns;
  // The conversation as the chat loop would hold it, so the system prompt is the one without the note on tool names.
  const messages: ChatMessage[] = [{ role: "system", content: options.system }];
  settings.transcript?.(who, model, messages);
  try {
    tools = await serveTools(options, who);
    const common = baseArgs(model, submit, settings.effort, tools.url);
    // Chosen here, so a run stopped before it reports its session can still be resumed.
    const session = randomUUID();
    const start = (id: string): string[] => ["--session-id", id, "--system-prompt", system];
    const resume = ["--resume", session, "--system-prompt", system];
    // The size of the conversation, counted as the chat loop counts it.
    let contextChars = system.length;
    const call = async (how: string[], turns: number, prompt: string, timeoutMs: number, investigating = false): Promise<Result | null> => {
      if (turns <= 0 || timeoutMs <= 0) throw new Error(`${who}: no budget left for the answer`);
      messages.push({ role: "user", content: prompt });
      contextChars += prompt.length;
      const run = await runClaude(settings.command ?? "claude", [...common, "--max-turns", String(turns), ...how], prompt, {
        cwd, timeoutMs, graceMs,
        // Past the size limit an investigation is stopped and asked for its answer, which bounds the cost of every later turn.
        stopAt: (event) => {
          contextChars += eventChars(event);
          return investigating && contextChars > MAX_CONTEXT_CHARS;
        },
      });
      const { result, events, error } = run;
      transcribe(events, submitName, messages);
      record(settings, options.caller, run);
      // Without final totals, charge the whole allowance: unseen turns may have run.
      // A missing saved session is a setup error and consumed no model turns.
      const missingSession = error && !events.some((event) => event.type === "assistant") && /No conversation found with session ID/i.test(error.message);
      turnsLeft -= missingSession ? 0 : (result?.num_turns ?? turns);
      if (error) throw error;
      return result;
    };
    /** Asks for the answer alone, in the time that is left. */
    const answer = (how: string[], prompt: string): Promise<Result | null> => call(how, Math.min(ANSWER_TURNS, turnsLeft), prompt, deadline - Date.now() - graceMs);

    let request = options.prompt;
    for (let round = 1; ; round += 1) {
      const how = round === 1 ? start(session) : resume;
      // Investigation stops short of the deadline, keeping the wrap-up time for the answer.
      const investigateMs = deadline - Date.now() - wrapUpMs;
      let result: Result | null;
      let wrappedUp = false;
      if (investigateMs > 0 && turnsLeft > ANSWER_TURNS) {
        result = await call(how, turnsLeft - ANSWER_TURNS, request, investigateMs, true).catch((error: unknown) => {
          if (!(error instanceof Error) || !recoverable(error.message)) throw error;
          log(`${who}: investigation failed (${error.message}); asking for its answer`);
          return null;
        });
        const why = contextChars > MAX_CONTEXT_CHARS ? "stopped at the conversation size limit" : "stopped to keep time for the answer";
        log(`${who}: round ${round}: ${result ? describeRun(result) : why}`);
        if (!result || result.subtype === "error_max_turns" || (result.is_error && recoverable([result.result, ...(result.errors ?? [])].filter(Boolean).join("\n")))) {
          wrappedUp = true;
          const stopped = !result;
          result = await answer(resume, answerNow).catch((error) => {
            // A run stopped before Claude Code saved its session cannot be resumed. Ask in a new session instead.
            if (!stopped || round > 1 || !(error instanceof Error) || !/No conversation found with session ID/i.test(error.message)) throw error;
            log(`${who}: the stopped run could not be resumed (${error instanceof Error ? error.message : String(error)}); asking again from the start`);
            // The new session knows nothing of the stopped one, so its conversation starts over too.
            messages.splice(1);
            contextChars = system.length;
            return answer(start(randomUUID()), `${request}\n\n${answerNow}`);
          });
        }
      } else {
        // No time to investigate. Like the chat loop, go straight to the answer.
        wrappedUp = true;
        result = await answer(how, `${request}\n\n${answerNow}`);
      }
      if (!result) throw new Error(`${who}: ran out of time before giving its ${submitName} answer`);
      if (wrappedUp) log(`${who}: round ${round} wrap-up: ${describeRun(result)}`);
      submissions.push(submissionOf(result, who, submitName));
      // A reviewer that had to be asked for its answer is not asked to look again.
      const room = turnsLeft > 0 && contextChars <= MAX_CONTEXT_CHARS && deadline - Date.now() > 2 * wrapUpMs;
      const next = secondLook && !wrappedUp && room ? secondLook.message(submissions.length) : null;
      if (!next) break;
      request = next;
    }
  } catch (error) {
    // A fallback continues the pass in the turns that are left, not a fresh budget.
    if (!submissions.length) throw Object.assign(error instanceof Error ? error : new Error(String(error)), { turnsUsed: options.maxTurns - turnsLeft });
    log(`${who}: a later round failed, keeping the submissions so far: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    tools?.close();
    await rm(cwd, { recursive: true, force: true });
  }
  return secondLook && submissions.length > 1 ? secondLook.combine(submissions) : submissions[0]!;
}
