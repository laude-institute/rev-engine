// Reads the agent contract's inputs and this reviewer's settings from the environment.

export type VerifyMode = "off" | "lenient" | "strict";

export interface Config {
  nwo: string;
  prNumber: number;
  base: string;
  head: string;
  agent: string;
  repoDir: string;
  diffPath: string;
  prJsonPath: string;
  outPath: string;
  apiKey: string;
  baseUrl: string;
  /** One independent review seat per model. */
  models: string[];
  verifierModel: string;
  verify: VerifyMode;
  effort: string | null;
  maxFindings: number;
  /** Wall-clock budget for the whole run. */
  budgetMs: number;
  maxTurns: number;
}

export const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_MODEL = "openai/gpt-6-luna";

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function sha(env: Env, name: string): string {
  const value = required(env, name);
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${name} is not a 40-character commit SHA`);
  return value;
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function loadConfig(env: Env): Config {
  const prNumber = Number(required(env, "RB_PR_NUMBER"));
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw new Error("RB_PR_NUMBER is not a positive integer");

  const models = (env.RB_CONFIG_MODEL ?? DEFAULT_MODEL).split(",").map((model) => model.trim()).filter(Boolean);
  if (!models.length) throw new Error("RB_CONFIG_MODEL names no model");

  const verify = (env.RB_CONFIG_VERIFY?.trim() || "lenient") as VerifyMode;
  if (!["off", "lenient", "strict"].includes(verify)) throw new Error("RB_CONFIG_VERIFY must be off, lenient or strict");

  return {
    nwo: required(env, "RB_NWO"),
    prNumber,
    base: sha(env, "RB_BASE"),
    head: sha(env, "RB_HEAD"),
    agent: env.RB_AGENT?.trim() || "rev-engine-prime",
    repoDir: env.RB_REPO?.trim() || "/work/repo",
    diffPath: env.RB_DIFF?.trim() || "/work/pr/diff.patch",
    prJsonPath: env.RB_PR_JSON?.trim() || "/work/pr/pr.json",
    outPath: required(env, "RB_OUT"),
    apiKey: required(env, "OPENROUTER_API_KEY"),
    baseUrl: (env.RB_MODEL_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    models,
    verifierModel: env.RB_CONFIG_VERIFIER?.trim() || models[0]!,
    verify,
    effort: env.RB_CONFIG_EFFORT?.trim() || null,
    maxFindings: integer(env, "RB_CONFIG_MAX_FINDINGS", 25, 1, 100),
    budgetMs: integer(env, "RB_CONFIG_TIME_BUDGET", 780, 60, 7200) * 1000,
    maxTurns: integer(env, "RB_CONFIG_MAX_TURNS", 40, 2, 200),
  };
}

/** The settings line the benchmark looks for: every configured label value must appear in the output. */
export function describeSettings(config: Config): string {
  return [
    `model=${config.models.join(",")}`,
    `verifier=${config.verifierModel}`,
    `verify=${config.verify}`,
    `effort=${config.effort ?? "default"}`,
    `max_findings=${config.maxFindings}`,
    `time_budget=${config.budgetMs / 1000}`,
    `max_turns=${config.maxTurns}`,
  ].join(" ");
}
