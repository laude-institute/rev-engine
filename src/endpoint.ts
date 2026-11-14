// Reads where a model API is and how to call it. Any endpoint that speaks the
// OpenAI chat completions API, or the Responses API, works the same way; nothing
// here knows one provider from another. Kept free of the reviewer's other
// modules, so scripts and the local runner's doctor can read the same settings.
import { readFileSync } from "node:fs";

export type Env = Record<string, string | undefined>;

export interface Endpoint {
  /** Such as https://example.test/v1; the client adds chat/completions or responses. */
  baseUrl: string;
  apiKey: string;
  /** "chat" posts to chat/completions; "responses" posts to the OpenAI Responses API. */
  api: "chat" | "responses";
  /** Fields merged into every request body, for what one endpoint accepts and another does not. */
  extraBody: Record<string, unknown>;
}

/**
 * The endpoint the RB_<prefix>_* settings and the <prefix>_API_KEY key describe:
 * MODEL for the reviewer's chat API, FALLBACK for the claude-code engine's fallback.
 * OPENROUTER_API_KEY is still read as an older name for MODEL_API_KEY.
 */
export function endpointOf(env: Env, prefix: "MODEL" | "FALLBACK"): Endpoint {
  const name = `RB_${prefix}_BASE_URL`;
  const raw = env[name]?.trim();
  if (!raw) throw new Error(`missing ${name}, the OpenAI-compatible API to call, such as https://example.test/v1`);
  const baseUrl = raw.replace(/\/+$/, "");
  let protocol = "";
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    // Reported below.
  }
  if (protocol !== "https:" && protocol !== "http:") throw new Error(`${name} must be an http or https URL, not ${baseUrl}`);

  const keyName = `${prefix}_API_KEY`;
  const apiKey = env[keyName]?.trim() || (prefix === "MODEL" ? env.OPENROUTER_API_KEY?.trim() : undefined);
  if (!apiKey) throw new Error(`missing ${keyName}, the key for ${name}`);

  const api = env[`RB_${prefix}_API`]?.trim() || "chat";
  if (api !== "chat" && api !== "responses") throw new Error(`RB_${prefix}_API must be chat or responses`);

  const extraName = `RB_${prefix}_EXTRA_BODY`;
  let extraBody: unknown = {};
  const extra = env[extraName]?.trim();
  if (extra) {
    try {
      extraBody = JSON.parse(extra);
    } catch {
      throw new Error(`${extraName} is not JSON`);
    }
    if (!extraBody || typeof extraBody !== "object" || Array.isArray(extraBody)) throw new Error(`${extraName} must be a JSON object`);
  }
  return { baseUrl, apiKey, api, extraBody: extraBody as Record<string, unknown> };
}

/** The NAME=value lines of an env file, for scripts that read the reviewer's .env. A missing file is empty. */
export function readEnvFile(path: string): Env {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const env: Env = {};
  for (const line of text.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) env[match[1]!] = match[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return env;
}
