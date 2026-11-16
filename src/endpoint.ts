// Reads where a model API is and how to call it. Any endpoint that speaks the
// OpenAI chat completions API, or the Responses API, works the same way; nothing
// here knows one provider from another. Kept free of the reviewer's other
// modules, so scripts and the local runner's doctor can read the same settings.
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

export type Env = Record<string, string | undefined>;

export interface Endpoint {
  /** Such as https://example.test/v1; the client adds chat/completions or responses. */
  baseUrl: string;
  apiKey: string;
  /** "chat" posts to chat/completions; "responses" posts to the OpenAI Responses API. */
  api: "chat" | "responses";
  /** Fields merged into every request body, for what one endpoint accepts and another does not. */
  extraBody: Record<string, unknown>;
  /**
   * Fields merged into the request body of a model whose name starts with the key, such as
   * {"anthropic/": {"cache_control": {"type": "ephemeral"}}}, for what only some models take.
   */
  extraBodyByModel: Record<string, Record<string, unknown>>;
}

/**
 * The endpoint the RB_<prefix>_* settings and the <prefix>_API_KEY key describe:
 * MODEL for the reviewer's chat API, FALLBACK for the claude-code engine's fallback.
 * OPENROUTER_API_KEY is accepted only for the standard OpenRouter endpoint.
 */
export function endpointOf(env: Env, prefix: "MODEL" | "FALLBACK"): Endpoint {
  const name = `RB_${prefix}_BASE_URL`;
  const raw = env[name]?.trim();
  if (!raw) throw new Error(`missing ${name}, the OpenAI-compatible API to call, such as https://example.test/v1`);
  const baseUrl = raw.replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`${name} must be an http or https URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${name} must be an http or https URL`);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && !loopback) throw new Error(`${name} must use HTTPS except on loopback for local development`);
  // Credentials belong in the key variable, not a URL that may be logged.
  if (url.username || url.password || url.search || url.hash) throw new Error(`${name} must not contain credentials, a query or a fragment`);

  const keyName = `${prefix}_API_KEY`;
  let apiKey = env[keyName]?.trim();
  if (!apiKey && prefix === "MODEL" && env.OPENROUTER_API_KEY?.trim()) {
    if (baseUrl !== "https://openrouter.ai/api/v1") throw new Error("OPENROUTER_API_KEY requires the standard OpenRouter endpoint; set MODEL_API_KEY explicitly for another endpoint");
    apiKey = env.OPENROUTER_API_KEY.trim();
  }
  if (!apiKey) throw new Error(`missing ${keyName}, the key for ${name}`);

  const api = env[`RB_${prefix}_API`]?.trim() || "chat";
  if (api !== "chat" && api !== "responses") throw new Error(`RB_${prefix}_API must be chat or responses`);

  const extraBody = jsonObject(env, `RB_${prefix}_EXTRA_BODY`);
  const byModelName = `RB_${prefix}_EXTRA_BODY_BY_MODEL`;
  const extraBodyByModel = jsonObject(env, byModelName);
  for (const [model, fields] of Object.entries(extraBodyByModel)) {
    if (!isObject(fields)) throw new Error(`${byModelName} must map each model name prefix to a JSON object, not ${model}`);
  }
  return { baseUrl, apiKey, api, extraBody, extraBodyByModel: extraBodyByModel as Endpoint["extraBodyByModel"] };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The JSON object a setting holds, or an empty one when it is unset. */
function jsonObject(env: Env, name: string): Record<string, unknown> {
  const raw = env[name]?.trim();
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${name} is not JSON`);
  }
  if (!isObject(value)) throw new Error(`${name} must be a JSON object`);
  return value;
}

/**
 * Lays each set of fields over the ones before it. A field that is an object in both is
 * merged one level deep, so a call's {"provider":{"sort":"latency"}} keeps an operator's
 * {"provider":{"data_collection":"deny"}}.
 */
export function mergeBodies(...bodies: Array<Record<string, unknown> | undefined>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const body of bodies) {
    for (const [name, value] of Object.entries(body ?? {})) {
      const earlier = merged[name];
      merged[name] = isObject(earlier) && isObject(value) ? { ...earlier, ...value } : value;
    }
  }
  return merged;
}

/** The NAME=value lines of an env file, for scripts that read the reviewer's .env. A missing file is empty. */
export function readEnvFile(path: string): Env {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  return parseEnv(text);
}
