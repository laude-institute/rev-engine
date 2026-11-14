// A small client for OpenRouter chat completions and the direct OpenAI Responses API.
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
  /** Original Responses output, preserved in order for stateless replay and saved transcripts. */
  response_output?: Array<Record<string, unknown>>;
  /**
   * The upstream provider OpenRouter routed the call to. It is not enumerable, so it is never
   * sent back to the API with the conversation.
   */
  provider?: string;
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
  /** The most tokens the model may reason for on this call; takes the place of the effort. OpenRouter only. */
  reasoningTokens?: number;
  /** Asks OpenRouter to route to the provider with the lowest latency or highest throughput. */
  providerSort?: "latency" | "throughput";
  /** OpenRouter only: the providers allowed to serve this call, such as "together"; no others are tried. */
  providers?: string[];
}

export type Chat = (request: ChatRequest) => Promise<ChatMessage>;

export interface Usage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** Null when any call has no reported cost. */
  costUsd: number | null;
}

export function emptyUsage(): Usage {
  return { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0 };
}

/** An unknown cost makes the total unknown, rather than silently undercounting it. */
export function addCosts(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}

export function formatCost(cost: number | null, digits = 4): string {
  return cost === null ? "unknown" : `$${cost.toFixed(digits)}`;
}

export function roundedCost(cost: number | null): number | null {
  return cost === null ? null : Number(cost.toFixed(6));
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

  // Direct OpenAI requests use Responses so encrypted reasoning can be replayed
  // without storing the conversation with the provider.
  const openAiResponses = new URL(options.baseUrl).hostname === "api.openai.com";

  async function post(path: string, body: Record<string, unknown>, timeoutMs: number): Promise<any> {
    const response = await fetchImpl(`${options.baseUrl.replace(/\/$/, "")}/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json", "x-title": "rev-engine-prime" },
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
    // Some providers report upstream failures inside a successful HTTP response.
    if (payload?.error) {
      const status = Number(payload.error.code) || 502;
      throw new ModelError(status, `model API error ${status}: ${String(payload.error.message).slice(0, 300)}`);
    }
    return payload;
  }

  function recordUsage(request: ChatRequest, spent: Omit<Usage, "calls">): void {
    const totals = [options.usage];
    if (request.caller && options.usageByCaller) {
      if (!options.usageByCaller.has(request.caller)) options.usageByCaller.set(request.caller, emptyUsage());
      totals.push(options.usageByCaller.get(request.caller)!);
    }
    for (const usage of totals) {
      usage.calls += 1;
      usage.promptTokens += spent.promptTokens;
      usage.completionTokens += spent.completionTokens;
      usage.cachedTokens += spent.cachedTokens;
      usage.costUsd = addCosts(usage.costUsd, spent.costUsd);
    }
  }

  async function responsesOnce(request: ChatRequest, timeoutMs: number, effort: string | null | undefined): Promise<ChatMessage> {
    const input: unknown[] = [];
    for (const message of request.messages) {
      if (message.role === "tool") {
        input.push({ type: "function_call_output", call_id: message.tool_call_id, output: message.content ?? "" });
        continue;
      }
      if (message.role === "assistant") {
        if (message.response_output) {
          input.push(...message.response_output);
          continue;
        }
        // Older transcripts may have only normalized fields. Do not replay lone reasoning.
        if ((message.content || message.tool_calls?.length) && Array.isArray(message.reasoning_details)) input.push(...message.reasoning_details);
        if (message.content) input.push({ role: "assistant", content: message.content });
        for (const call of message.tool_calls ?? []) {
          input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
        }
        continue;
      }
      input.push({ role: message.role, content: message.content ?? "" });
    }
    const body: Record<string, unknown> = {
      model: request.model,
      input,
      tools: request.tools.map((tool) => ({ type: "function", name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters, strict: false })),
      // Require a tool on this endpoint so a plain-text answer cannot bypass the
      // submission/second-look protocol. Chat-completions providers retain their existing policy.
      tool_choice: request.forceTool ? { type: "function", name: request.forceTool } : (request.tools.length ? "required" : "auto"),
      max_output_tokens: MAX_OUTPUT_TOKENS,
      store: false,
      include: ["reasoning.encrypted_content"],
    };
    if (effort) body.reasoning = { effort };
    const payload = await post("responses", body, timeoutMs);
    if (!Array.isArray(payload?.output)) throw new ModelError(502, "model API returned no message");
    recordUsage(request, {
      promptTokens: Number(payload.usage?.input_tokens) || 0,
      completionTokens: Number(payload.usage?.output_tokens) || 0,
      cachedTokens: Number(payload.usage?.input_tokens_details?.cached_tokens) || 0,
      costUsd: null, // Responses reports tokens, not a billed dollar amount.
    });
    if (payload.status && payload.status !== "completed" && payload.status !== "incomplete") {
      throw new ModelError(502, `model API returned response status ${payload.status}`);
    }

    const texts: string[] = [];
    const calls: ToolCall[] = [];
    const reasoning: unknown[] = [];
    for (const item of payload.output) {
      if (!item || typeof item !== "object") throw new ModelError(502, "model API returned an invalid output item");
      if (item.type === "reasoning") reasoning.push(item);
      else if (item.type === "function_call") calls.push({ id: String(item.call_id), type: "function", function: { name: String(item.name ?? ""), arguments: String(item.arguments ?? "") } });
      else if (item.type === "message") {
        for (const part of item.content ?? []) if (part.type === "output_text") texts.push(String(part.text ?? ""));
      }
    }
    const result: ChatMessage = { role: "assistant", content: texts.length ? texts.join("\n") : null };
    if (calls.length) result.tool_calls = calls;
    // Token exhaustion can leave only unfinished reasoning. Let the agent ask again
    // without placing that unusable turn into the next request. Keep partial calls so
    // the agent can recover complete findings from a truncated submission.
    if (texts.length || calls.length) {
      result.response_output = payload.output;
      if (reasoning.length) result.reasoning_details = reasoning;
    }
    return result;
  }

  async function once(request: ChatRequest, timeoutMs: number): Promise<ChatMessage> {
    if (openAiResponses) return responsesOnce(request, timeoutMs, request.effort ?? options.effort);
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(({ response_output, ...message }) => message),
      tools: request.tools,
      tool_choice: request.forceTool ? { type: "function", function: { name: request.forceTool } } : "auto",
      max_tokens: MAX_OUTPUT_TOKENS,
    };
    if (openRouter) body.usage = { include: true };
    if (openRouter && (request.providerSort || request.providers?.length)) {
      body.provider = {
        ...(request.providerSort ? { sort: request.providerSort } : {}),
        ...(request.providers?.length ? { only: request.providers, allow_fallbacks: false } : {}),
      };
    }
    // Anthropic models cache a prompt prefix only when asked to. A review resends a
    // growing conversation every turn, so caching decides most of its cost.
    if (openRouter && request.model.startsWith("anthropic/")) body.cache_control = { type: "ephemeral" };
    const effort = request.effort ?? options.effort;
    if (openRouter && request.reasoningTokens) body.reasoning = { max_tokens: request.reasoningTokens };
    else if (effort) {
      if (openRouter) body.reasoning = { effort };
      else body.reasoning_effort = effort;
    }
    const payload = await post("chat/completions", body, timeoutMs);
    const message = payload?.choices?.[0]?.message;
    if (!message) throw new ModelError(502, "model API returned no message");
    recordUsage(request, {
      promptTokens: Number(payload.usage?.prompt_tokens) || 0,
      completionTokens: Number(payload.usage?.completion_tokens) || 0,
      cachedTokens: Number(payload.usage?.prompt_tokens_details?.cached_tokens) || 0,
      costUsd: Number(payload.usage?.cost) || 0,
    });

    const result: ChatMessage = { role: "assistant", content: typeof message.content === "string" ? message.content : null };
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      result.tool_calls = message.tool_calls.map((call: any, index: number): ToolCall => ({
        id: String(call.id ?? `call_${index}`),
        type: "function",
        function: { name: String(call.function?.name ?? ""), arguments: String(call.function?.arguments ?? "") },
      }));
    }
    if (message.reasoning_details) result.reasoning_details = message.reasoning_details;
    if (typeof payload.provider === "string") Object.defineProperty(result, "provider", { value: payload.provider, enumerable: false });
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
