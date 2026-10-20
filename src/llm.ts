// A small chat-completions client for OpenRouter and other OpenAI-compatible endpoints.
import type { ToolDefinition } from "./tools.ts";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Provider reasoning blocks, which some models need returned unchanged on the next turn. */
  reasoning_details?: unknown;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  /** A tool name forces that tool; otherwise the model chooses. */
  forceTool?: string;
  timeoutMs: number;
  /** Names who is asking, such as "s1" or "verifier", so usage can be totalled for each. */
  caller?: string;
  /** The longest one attempt may take, when shorter than ATTEMPT_TIMEOUT_MS. */
  attemptTimeoutMs?: number;
  /** Reasoning effort for this call, in place of the client's. */
  effort?: string;
  /** Asks OpenRouter to route to the provider with the lowest latency or highest throughput. */
  providerSort?: "latency" | "throughput";
}

export type Chat = (request: ChatRequest) => Promise<ChatMessage>;

export interface Usage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: number;
}

export function emptyUsage(): Usage {
  return { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0 };
}

export class ModelError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const RETRY_DELAYS_MS = [1_000, 4_000, 10_000];
/** The longest one attempt may take. A call that stalls is cut off here and retried while the caller's time allows. */
const ATTEMPT_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_TOKENS = 16_000;

function retryable(error: unknown): boolean {
  if (error instanceof ModelError) return error.status === 408 || error.status === 429 || error.status >= 500;
  return true; // network failures and timeouts
}

export interface ClientOptions {
  apiKey: string;
  baseUrl: string;
  effort: string | null;
  usage: Usage;
  /** Filled with the usage of each caller that names itself in its requests. */
  usageByCaller?: Map<string, Usage>;
  fetchImpl?: typeof fetch;
}

export function createChat(options: ClientOptions): Chat {
  const fetchImpl = options.fetchImpl ?? fetch;
  const openRouter = new URL(options.baseUrl).hostname.endsWith("openrouter.ai");

  async function once(request: ChatRequest, timeoutMs: number): Promise<ChatMessage> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      tools: request.tools,
      tool_choice: request.forceTool ? { type: "function", function: { name: request.forceTool } } : "auto",
      max_tokens: MAX_OUTPUT_TOKENS,
    };
    if (openRouter) body.usage = { include: true };
    if (openRouter && request.providerSort) body.provider = { sort: request.providerSort };
    // Anthropic models cache a prompt prefix only when asked to. A review resends a
    // growing conversation every turn, so caching decides most of its cost.
    if (openRouter && request.model.startsWith("anthropic/")) body.cache_control = { type: "ephemeral" };
    const effort = request.effort ?? options.effort;
    if (effort) {
      if (openRouter) body.reasoning = { effort };
      else body.reasoning_effort = effort;
    }
    const response = await fetchImpl(`${options.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
        "x-title": "rev-engine-prime",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) throw new ModelError(response.status, `model API returned ${response.status}: ${text.slice(0, 300)}`);
    let payload: any;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ModelError(502, "model API returned a body that is not JSON");
    }
    // OpenRouter reports some upstream failures inside a 200 response.
    if (payload?.error) {
      const status = Number(payload.error.code) || 502;
      throw new ModelError(status, `model API error ${status}: ${String(payload.error.message).slice(0, 300)}`);
    }
    const message = payload?.choices?.[0]?.message;
    if (!message) throw new ModelError(502, "model API returned no message");

    const totals = [options.usage];
    if (request.caller && options.usageByCaller) {
      if (!options.usageByCaller.has(request.caller)) options.usageByCaller.set(request.caller, emptyUsage());
      totals.push(options.usageByCaller.get(request.caller)!);
    }
    for (const usage of totals) {
      usage.calls += 1;
      usage.promptTokens += Number(payload.usage?.prompt_tokens) || 0;
      usage.completionTokens += Number(payload.usage?.completion_tokens) || 0;
      usage.cachedTokens += Number(payload.usage?.prompt_tokens_details?.cached_tokens) || 0;
      usage.costUsd += Number(payload.usage?.cost) || 0;
    }

    const result: ChatMessage = { role: "assistant", content: typeof message.content === "string" ? message.content : null };
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      result.tool_calls = message.tool_calls.map((call: any, index: number): ToolCall => ({
        id: String(call.id ?? `call_${index}`),
        type: "function",
        function: { name: String(call.function?.name ?? ""), arguments: String(call.function?.arguments ?? "") },
      }));
    }
    if (message.reasoning_details) result.reasoning_details = message.reasoning_details;
    return result;
  }

  return async function chat(request: ChatRequest): Promise<ChatMessage> {
    const deadline = Date.now() + request.timeoutMs;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await once(request, Math.max(1_000, Math.min(request.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS, ATTEMPT_TIMEOUT_MS, deadline - Date.now())));
      } catch (error) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined || !retryable(error) || Date.now() + delay >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  };
}
