// The tool loop: a model inspects the pull request with read tools, then
// hands back its result by calling a submit tool.
//
// Using a tool for the final answer works with any model that can call tools,
// and the arguments are checked as JSON before the loop accepts them.
import { ModelError, type Chat, type ChatMessage } from "./llm.ts";
import { readTools, type ToolDefinition, type Workspace } from "./tools.ts";

/**
 * Time kept back at the end for the model to write its submission. Ordinary
 * turns may not run into it, so one slow call cannot use up the whole deadline.
 */
const WRAP_UP_MS = 100_000;
/** Conversation size, in characters, past which the model is told to submit. Bounds the cost of every later turn. */
const MAX_CONTEXT_CHARS = 800_000;

/** A request to look again after the first submission, and how to join the two submissions. */
export interface SecondLook {
  message: () => string;
  combine: (first: Record<string, unknown>, second: Record<string, unknown>) => Record<string, unknown>;
}

export interface AgentOptions {
  chat: Chat;
  model: string;
  system: string;
  prompt: string;
  workspace: Workspace;
  submit: ToolDefinition;
  /** Epoch milliseconds by which the submission must be in. */
  deadline: number;
  maxTurns: number;
  /** When set, the first submission is answered with this request and the model submits once more. */
  secondLook?: SecondLook;
  log: (message: string) => void;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Some models answer in prose with a JSON block instead of calling the submit tool. */
function objectFromText(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];
  for (const candidate of candidates) {
    const value = candidate ? parseObject(candidate) : null;
    if (value) return value;
  }
  return null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A short label for a tool call in the log, such as "read_file src/pool.ts". */
function label(name: string, rawArguments: string): string {
  const args = parseObject(rawArguments);
  const target = typeof args?.path === "string" ? args.path : typeof args?.query === "string" ? JSON.stringify(args.query) : "";
  return `${name} ${target}`.trim().slice(0, 80);
}

export async function runAgent(options: AgentOptions): Promise<Record<string, unknown>> {
  // The first submission is kept, so a failure during the second look still returns a finished review.
  const held: { first: Record<string, unknown> | null } = { first: null };
  try {
    return await loop(options, held);
  } catch (error) {
    if (!held.first) throw error;
    options.log(`${options.model}: second look failed, keeping the first submission: ${describe(error)}`);
    return held.first;
  }
}

async function loop(options: AgentOptions, held: { first: Record<string, unknown> | null }): Promise<Record<string, unknown>> {
  const { chat, model, workspace, submit, deadline, maxTurns, secondLook, log } = options;
  const started = Date.now();
  const submitName = submit.function.name;
  const tools = [...readTools, submit];
  const messages: ChatMessage[] = [
    { role: "system", content: options.system },
    { role: "user", content: options.prompt },
  ];
  let wrappingUp = false;
  let forcedChoiceWorks = true;
  let contextChars = options.system.length + options.prompt.length;
  const push = (message: ChatMessage): void => {
    messages.push(message);
    contextChars += (message.content?.length ?? 0) + (message.tool_calls ?? []).reduce((sum, call) => sum + call.function.arguments.length, 0);
  };
  const wrapUp = (): void => {
    wrappingUp = true;
    push({ role: "user", content: `Stop investigating. Call ${submitName} now with what you have established so far.` });
  };

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`${model} ran out of time before submitting`);
    if (!wrappingUp && (turn === maxTurns || remaining <= WRAP_UP_MS || contextChars > MAX_CONTEXT_CHARS)) wrapUp();

    // An ordinary turn must leave the wrap-up window untouched; the wrap-up turn gets all that is left.
    const request = { model, messages, tools, timeoutMs: wrappingUp ? remaining : remaining - WRAP_UP_MS };
    let reply: ChatMessage;
    try {
      reply = await chat(wrappingUp && forcedChoiceWorks ? { ...request, forceTool: submitName } : request);
    } catch (error) {
      const rejected = error instanceof ModelError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
      if (wrappingUp && forcedChoiceWorks && rejected) {
        // Not every provider accepts a forced tool choice. Ask again and let the model choose.
        forcedChoiceWorks = false;
        reply = await chat(request);
      } else if (!wrappingUp && !rejected && deadline - Date.now() > 10_000) {
        // A slow or failing call used up the investigation time. Ask for the submission instead of giving up.
        log(`${model}: turn ${turn} failed (${describe(error)}); asking for the submission`);
        wrapUp();
        continue;
      } else {
        throw error;
      }
    }
    push(reply);

    const calls = reply.tool_calls ?? [];
    const elapsed = Math.round((Date.now() - started) / 1000);
    log(`${model}: turn ${turn} at ${elapsed}s: ${calls.map((call) => label(call.function.name, call.function.arguments)).join(", ") || "text"}`);

    const submission = calls.find((call) => call.function.name === submitName);
    if (submission) {
      const value = parseObject(submission.function.arguments);
      if (value && held.first && secondLook) return secondLook.combine(held.first, value);
      const lookAgain = Boolean(value && secondLook && !wrappingUp && deadline - Date.now() > 2 * WRAP_UP_MS);
      if (value && !lookAgain) return value;
      if (value) held.first = value;
      // Every call needs a result before the next turn. An unparsable submission is usually output cut off mid-JSON.
      const content = value
        ? JSON.stringify({ ok: true, status: "received, not final yet", next: secondLook!.message() })
        : JSON.stringify({ ok: false, error: `the ${submitName} arguments were not valid JSON; call it again with fewer or shorter entries` });
      for (const call of calls) push({ role: "tool", tool_call_id: call.id, content });
      continue;
    }

    if (!calls.length) {
      const value = reply.content ? objectFromText(reply.content) : null;
      if (value) return value;
      push({ role: "user", content: `Continue. When you are done, call ${submitName}; do not answer in plain text.` });
      continue;
    }

    for (const call of calls) {
      push({ role: "tool", tool_call_id: call.id, content: await workspace.call(call.function.name, call.function.arguments) });
    }
  }
  throw new Error(`${model} did not submit within ${maxTurns} turns`);
}
