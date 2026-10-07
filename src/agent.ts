// The tool loop: a model inspects the pull request with read tools, then
// hands back its result by calling a submit tool.
//
// Using a tool for the final answer works with any model that can call tools,
// and the arguments are checked as JSON before the loop accepts them.
import { ModelError, type Chat, type ChatMessage } from "./llm.ts";
import { readTools, type ToolDefinition, type Workspace } from "./tools.ts";

/** How long before the deadline the model is told to stop reading and submit. */
const WRAP_UP_MS = 75_000;
const MAX_CALL_MS = 300_000;

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

export async function runAgent(options: AgentOptions): Promise<Record<string, unknown>> {
  const { chat, model, workspace, submit, deadline, maxTurns, log } = options;
  const submitName = submit.function.name;
  const tools = [...readTools, submit];
  const messages: ChatMessage[] = [
    { role: "system", content: options.system },
    { role: "user", content: options.prompt },
  ];
  let wrappingUp = false;
  let forcedChoiceWorks = true;

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`${model} ran out of time before submitting`);
    if (!wrappingUp && (turn === maxTurns || remaining < WRAP_UP_MS)) {
      wrappingUp = true;
      messages.push({ role: "user", content: `Stop investigating. Call ${submitName} now with what you have established so far.` });
    }

    const request = { model, messages, tools, timeoutMs: Math.min(remaining, MAX_CALL_MS) };
    let reply: ChatMessage;
    try {
      reply = await chat(wrappingUp && forcedChoiceWorks ? { ...request, forceTool: submitName } : request);
    } catch (error) {
      // Not every provider accepts a forced tool choice. Ask again and let the model choose.
      const rejected = error instanceof ModelError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
      if (!(wrappingUp && forcedChoiceWorks && rejected)) throw error;
      forcedChoiceWorks = false;
      reply = await chat(request);
    }
    messages.push(reply);

    const calls = reply.tool_calls ?? [];
    const submission = calls.find((call) => call.function.name === submitName);
    if (submission) {
      const value = parseObject(submission.function.arguments);
      if (value) {
        log(`${model}: submitted after ${turn} turn(s)`);
        return value;
      }
      // Usually output cut off mid-JSON. Every call needs a result before the next turn.
      for (const call of calls) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ ok: false, error: `the ${submitName} arguments were not valid JSON; call it again with fewer or shorter entries` }),
        });
      }
      continue;
    }

    if (!calls.length) {
      const value = reply.content ? objectFromText(reply.content) : null;
      if (value) {
        log(`${model}: answered in text after ${turn} turn(s)`);
        return value;
      }
      messages.push({ role: "user", content: `Continue. When you are done, call ${submitName}; do not answer in plain text.` });
      continue;
    }

    for (const call of calls) {
      messages.push({ role: "tool", tool_call_id: call.id, content: await workspace.call(call.function.name, call.function.arguments) });
    }
  }
  throw new Error(`${model} did not submit within ${maxTurns} turns`);
}
