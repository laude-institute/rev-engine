// Pure helpers for scripts/local.ts.
//
// The reviewer is normally started by ReviewBench, which mounts the pull request
// at /work/repo and /work/pr and hands over a set of RB_* variables. Running it
// on a developer's machine means computing that same input from a local git
// checkout, so this module holds the parts worth testing on their own: the
// argument parser, the environment builder and the finding summary.
import type { Severity } from "../../src/findings.ts";

export interface Settings {
  [key: string]: string;
}

export interface LocalOptions {
  command: "branch" | "pr" | "doctor";
  /** The pull request number in pr mode. */
  number: number | null;
  repo: string;
  base: string | null;
  settings: Settings;
  prNumber: number;
  json: boolean;
  quiet: boolean;
  keep: boolean;
  dryRun: boolean;
  failOn: "none" | Severity;
  prior: string;
}

/** The container setting each command-line flag sets, in the same spelling the benchmark uses as a label. */
export const SETTING_NAMES = [
  "model", "verifier", "verify", "second_look", "min_severity",
  "max_findings", "mode", "time_budget", "max_turns", "effort", "fit",
  "follow_up", "retry_empty",
] as const;

type SettingName = (typeof SETTING_NAMES)[number];

/** The contract's name for a setting: `min_severity` becomes `RB_CONFIG_MIN_SEVERITY`. */
export function envNameOf(setting: string): string {
  return `RB_CONFIG_${setting.toUpperCase()}`;
}

const SEVERITY_CHOICES: Severity[] = ["high", "medium", "low"];

export class UsageError extends Error {}

function value(args: string[], index: number, flag: string): string {
  const next = args[index + 1];
  if (next === undefined) throw new UsageError(`${flag} needs a value`);
  return next;
}

function integer(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) throw new UsageError(`${flag} must be a positive integer`);
  return parsed;
}

/**
 * Parses the command line. Values that name a setting go into `settings`, so a
 * flag has exactly one meaning: it sets the container setting of the same name.
 */
export function parseArgs(args: string[]): LocalOptions {
  const [command, ...rest] = args;
  if (command !== "branch" && command !== "pr" && command !== "doctor") {
    throw new UsageError("usage: scripts/local.ts branch|pr <number>|doctor [options]");
  }

  const options: LocalOptions = {
    command,
    number: null,
    repo: ".",
    base: null,
    settings: {},
    prNumber: 1,
    json: false,
    quiet: false,
    keep: false,
    dryRun: false,
    failOn: "none",
    prior: "auto",
  };
  const positional: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]!;
    if (!flag.startsWith("--")) {
      positional.push(flag);
      continue;
    }
    switch (flag) {
      case "--json": options.json = true; break;
      case "--quiet": options.quiet = true; break;
      case "--keep": options.keep = true; break;
      case "--dry-run": options.dryRun = true; break;
      case "--repo": options.repo = value(rest, index++, flag); break;
      case "--base": options.base = value(rest, index++, flag); break;
      case "--prior": options.prior = value(rest, index++, flag); break;
      case "--pr-number": options.prNumber = integer(value(rest, index++, flag), flag); break;
      case "--fail-on": {
        const threshold = value(rest, index++, flag);
        if (threshold !== "none" && !SEVERITY_CHOICES.includes(threshold as Severity)) {
          throw new UsageError("--fail-on must be none, high, medium or low");
        }
        options.failOn = threshold as LocalOptions["failOn"];
        break;
      }
      case "--set": {
        // Any plausible name is accepted here: which settings exist is read from
        // the checkout, so a branch adding one needs no change in this parser.
        const pair = value(rest, index++, flag);
        const split = pair.indexOf("=");
        if (split === -1) throw new UsageError(`--set wants key=value, got ${pair}`);
        const key = pair.slice(0, split);
        if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new UsageError(`--set names an unusable setting ${key}`);
        options.settings[key] = pair.slice(split + 1);
        break;
      }
      // Every other flag is a setting flag; --some-name sets some_name.
      default: {
        const key = flag.slice(2).replaceAll("-", "_");
        if (!SETTING_NAMES.includes(key as SettingName)) throw new UsageError(`unknown option ${flag}`);
        const raw = value(rest, index++, flag);
        options.settings[key] = raw;
        break;
      }
    }
  }

  if (command === "pr") {
    const number = positional[0];
    if (number === undefined) throw new UsageError("pr mode needs a pull request number");
    options.number = integer(number, "pull request number");
  } else if (positional.length) {
    throw new UsageError(`${command} takes no positional arguments, got ${positional.join(" ")}`);
  }
  return options;
}

/**
 * The settings the reviewer will actually apply.
 *
 * `available` is the set of settings this checkout reads. The reviewer rejects
 * an `RB_CONFIG_*` name it does not know, so a setting the checkout does not
 * define has to be refused here, where the message can say why, instead of
 * starting a run that fails a moment later with a less useful error.
 */
export function effectiveSettings(options: LocalOptions, available: Set<string>): Settings {
  const settings: Settings = { ...options.settings };
  for (const name of Object.keys(settings)) {
    if (available.has(name)) continue;
    const supported = [...available].sort().join(", ") || "none";
    throw new UsageError(
      `this checkout does not define the ${name} setting; it knows ${supported}`,
    );
  }
  return settings;
}

export interface ReviewEnvInput {
  nwo: string;
  number: number;
  base: string;
  head: string;
  repoDir: string;
  runDir: string;
  settings: Settings;
  agent?: string;
}

/**
 * The RB_* environment the reviewer container would receive, pointed at local
 * paths. Only RB_* keys are produced, so nothing else in the caller's
 * environment leaks into the reviewer's namespace.
 */
export function buildReviewEnv(input: ReviewEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    RB_NWO: input.nwo,
    RB_PR_NUMBER: String(input.number),
    RB_BASE: input.base,
    RB_HEAD: input.head,
    RB_AGENT: input.agent ?? "rev-engine-prime",
    RB_REPO: input.repoDir,
    RB_DIFF: `${input.runDir}/pr/diff.patch`,
    RB_PR_JSON: `${input.runDir}/pr/pr.json`,
    RB_PRIOR_JSON: `${input.runDir}/pr/prior.json`,
    RB_OUT: `${input.runDir}/out/findings.json`,
    RB_DETAILS_OUT: `${input.runDir}/out/details.json`,
    RB_CONTEXT_OUT: `${input.runDir}/out/context.json`,
    RB_ATTEMPT: "1",
  };
  // Every configured setting is passed, not only the names this file knows, so a
  // setting added to the reviewer reaches it without a change here.
  for (const [name, configured] of Object.entries(input.settings)) {
    if (configured !== undefined && configured !== "") env[envNameOf(name)] = configured;
  }
  return env;
}

/**
 * owner/repo from a GitHub clone URL, or a local placeholder otherwise. A remote
 * that is a path on this machine must not be reported as an owner/repository,
 * because findings carry this name.
 */
export function repoName(url: string | null, fallback: string): string {
  if (!url) return `local/${fallback}`;
  const value = url.trim();
  const https = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(value);
  const scp = /^[\w.-]+@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(value);
  const match = https ?? scp;
  return match && /github\.com/.test(value) ? `${match[1]}/${match[2]}` : `local/${fallback}`;
}

export interface Summary {
  high: number;
  medium: number;
  low: number;
  total: number;
}

/** Counts findings by severity; a missing or unexpected severity counts as low. */
export function summarize(findings: Array<{ severity?: string }>): Summary {
  const summary: Summary = { high: 0, medium: 0, low: 0, total: findings.length };
  for (const finding of findings) {
    const severity = finding.severity;
    if (severity === "high") summary.high += 1;
    else if (severity === "medium") summary.medium += 1;
    else summary.low += 1;
  }
  return summary;
}

/** Whether a summary reaches the threshold a gate was given. */
export function reaches(summary: Summary, threshold: LocalOptions["failOn"]): boolean {
  if (threshold === "none") return false;
  if (threshold === "high") return summary.high > 0;
  if (threshold === "medium") return summary.high > 0 || summary.medium > 0;
  return summary.total > 0;
}
