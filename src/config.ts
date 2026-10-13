// Reads the agent contract's inputs and this reviewer's settings from the environment.
import { dirname, join } from "node:path";
import type { Severity } from "./findings.ts";
import { FOCUS_NAMES } from "./prompts.ts";

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
  /** Which attempt at this pull request this is, starting at 1. */
  attempt: number;
  apiKey: string;
  baseUrl: string;
  /** One independent review seat per model. */
  models: string[];
  /** For each seat, the one focus it reviews for, or null for the full review. */
  focuses: Array<string | null>;
  verifierModel: string;
  verify: VerifyMode;
  /** Ask each reviewer to look again after its first submission. */
  secondLook: boolean;
  /** A model that reviews again after the seats, told what they found. Null for none. */
  followUpModel: string | null;
  /** Findings less severe than this are dropped before verification. */
  minSeverity: Severity;
  /** A model that judges whether the change belongs in the project. Null for none. */
  fitModel: string | null;
  /** Where the fit assessment is written. */
  fitOutPath: string;
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

  // Each seat is a model, optionally followed by "@" and the one focus it reviews for.
  const seats = (env.RB_CONFIG_MODEL ?? DEFAULT_MODEL).split(",").map((seat) => seat.trim()).filter(Boolean);
  if (!seats.length) throw new Error("RB_CONFIG_MODEL names no model");
  const models = seats.map((seat) => (seat.includes("@") ? seat.slice(0, seat.lastIndexOf("@")) : seat));
  const focuses = seats.map((seat) => (seat.includes("@") ? seat.slice(seat.lastIndexOf("@") + 1) : null));
  for (const focus of focuses) {
    if (focus !== null && !FOCUS_NAMES.includes(focus)) throw new Error(`RB_CONFIG_MODEL names an unknown focus "${focus}"; the choices are ${FOCUS_NAMES.join(", ")}`);
  }
  if (models.some((model) => !model)) throw new Error("RB_CONFIG_MODEL has a seat with no model");

  const verify = (env.RB_CONFIG_VERIFY?.trim() || "lenient") as VerifyMode;
  if (!["off", "lenient", "strict"].includes(verify)) throw new Error("RB_CONFIG_VERIFY must be off, lenient or strict");

  const secondLook = env.RB_CONFIG_SECOND_LOOK?.trim() || "on";
  if (!["on", "off"].includes(secondLook)) throw new Error("RB_CONFIG_SECOND_LOOK must be on or off");

  const minSeverity = (env.RB_CONFIG_MIN_SEVERITY?.trim() || "low") as Severity;
  if (!["high", "medium", "low"].includes(minSeverity)) throw new Error("RB_CONFIG_MIN_SEVERITY must be high, medium or low");

  const outPath = required(env, "RB_OUT");

  return {
    nwo: required(env, "RB_NWO"),
    prNumber,
    base: sha(env, "RB_BASE"),
    head: sha(env, "RB_HEAD"),
    agent: env.RB_AGENT?.trim() || "rev-engine-prime",
    repoDir: env.RB_REPO?.trim() || "/work/repo",
    diffPath: env.RB_DIFF?.trim() || "/work/pr/diff.patch",
    prJsonPath: env.RB_PR_JSON?.trim() || "/work/pr/pr.json",
    outPath,
    attempt: integer(env, "RB_ATTEMPT", 1, 1, 1000),
    apiKey: required(env, "OPENROUTER_API_KEY"),
    baseUrl: (env.RB_MODEL_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    models,
    focuses,
    verifierModel: env.RB_CONFIG_VERIFIER?.trim() || models[0]!,
    verify,
    secondLook: secondLook === "on",
    followUpModel: env.RB_CONFIG_FOLLOW_UP?.trim() || null,
    minSeverity,
    fitModel: env.RB_CONFIG_FIT?.trim() || null,
    fitOutPath: join(dirname(outPath), "fit.json"),
    effort: env.RB_CONFIG_EFFORT?.trim() || null,
    maxFindings: integer(env, "RB_CONFIG_MAX_FINDINGS", 25, 1, 100),
    budgetMs: integer(env, "RB_CONFIG_TIME_BUDGET", 780, 60, 7200) * 1000,
    maxTurns: integer(env, "RB_CONFIG_MAX_TURNS", 40, 2, 200),
  };
}

/** The settings line the benchmark looks for: every configured label value must appear in the output. */
export function describeSettings(config: Config): string {
  return [
    `model=${config.models.map((model, index) => (config.focuses[index] ? `${model}@${config.focuses[index]}` : model)).join(",")}`,
    `verifier=${config.verifierModel}`,
    `verify=${config.verify}`,
    `second_look=${config.secondLook ? "on" : "off"}`,
    `follow_up=${config.followUpModel ?? "off"}`,
    `min_severity=${config.minSeverity}`,
    `fit=${config.fitModel ?? "off"}`,
    `effort=${config.effort ?? "default"}`,
    `max_findings=${config.maxFindings}`,
    `time_budget=${config.budgetMs / 1000}`,
    `max_turns=${config.maxTurns}`,
  ].join(" ");
}
