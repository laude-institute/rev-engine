// Runs the reviewer on a local git checkout, without Docker and without
// ReviewBench.
//
// The container reads a pull request from a fixed mount layout. This script
// computes the same input from a working copy, then starts the same entry point
// (`src/main.ts`) with the same variables, so a review on a laptop goes through
// exactly the code path the benchmark and the GitHub Action use.
//
//   node scripts/local.ts branch --base main        # the current branch, before a pull request
//   node scripts/local.ts pr 1938                   # a pull request at its head
//   node scripts/local.ts doctor                    # check the environment
//
// A setting flag sets the container setting of the same name: `--min-severity
// high` is `RB_CONFIG_MIN_SEVERITY=high`, `--set KEY=VALUE` covers the rest.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  UsageError, buildReviewEnv, effectiveSettings, parseArgs, reaches,
  repoName, summarize, type LocalOptions, type Settings, type Summary,
} from "./local/layout.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const log = (message: string): void => console.error(`local: ${message}`);

/** A git command's trimmed output, or a readable failure. */
function git(args: string[], cwd: string, allowFailure = false): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0 && !allowFailure) {
    const detail = result.error?.message ?? ((result.stderr || result.stdout || "").trim().split("\n").pop() || String(result.status));
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
  return result.status === 0 ? result.stdout.trim() : "";
}

function repoRoot(path: string): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: path, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new UsageError(`${path} is not inside a git working tree`);
  return result.stdout.trim();
}

function remoteName(repo: string): string {
  const names = git(["remote"], repo, true).split("\n").filter(Boolean);
  return names.includes("origin") ? "origin" : (names[0] ?? "origin");
}

/** The branch a pull request would target: the remote's HEAD, then the usual names. */
function defaultBase(repo: string): string {
  const remote = remoteName(repo);
  const symbolic = git(["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`], repo, true);
  if (symbolic) return symbolic.replace(/^refs\/remotes\//, "");
  for (const candidate of [`${remote}/main`, `${remote}/master`, "main", "master"]) {
    if (spawnSync("git", ["rev-parse", "--verify", "--quiet", candidate], { cwd: repo }).status === 0) return candidate;
  }
  throw new UsageError("cannot tell the base branch; pass --base <ref>");
}

function sha(repo: string, ref: string): string {
  const value = git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], repo, true);
  if (!value) throw new UsageError(`cannot resolve ${ref} to a commit`);
  return value;
}

function mergeBase(repo: string, base: string, head: string): string {
  const value = git(["merge-base", base, head], repo, true);
  if (!value) throw new UsageError(`${base} and ${head} have no merge-base; pass --base <ref>`);
  return value;
}

/**
 * Which settings this checkout reads, taken from its own config source rather
 * than a list kept here, so the runner does not have to know about a setting
 * before the reviewer does.
 */
function availableSettings(repo: string): Set<string> {
  const available = new Set<string>();
  // Include the optional engine's own reads, without importing or executing it.
  for (const file of ["src/config.ts", "experiments/prototypes/swarm/review.ts"]) {
    const path = join(repo, file);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
    for (const match of source.matchAll(/(?:env\.RB_CONFIG_|(?:integer|required)\(env,\s*["']RB_CONFIG_)([A-Z0-9]+(?:_[A-Z0-9]+)*)/g)) {
      available.add(match[1]!.toLowerCase());
    }
  }
  return available;
}

interface Run {
  dir: string;
}

/** Write the exact patch directly to disk instead of buffering or trimming it. */
function prepareRun(label: string, pr: Record<string, unknown>, repo: string, base: string, head: string, prior: string): Run {
  let priorText: string | undefined;
  if (prior !== "none") {
    if (prior === "auto") throw new UsageError("--prior requires a file path or none; automatic collection is not supported");
    try {
      priorText = readFileSync(resolve(prior), "utf8");
      const parsed = JSON.parse(priorText) as { entries?: unknown };
      if (!parsed || !Array.isArray(parsed.entries)) throw new Error("expected an entries array");
    } catch (error) {
      throw new UsageError(`cannot use --prior file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const slug = label.replace(/[^A-Za-z0-9._-]+/g, "-");
  const parent = join(root, "runs", "local");
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, `${stamp}-${slug}-`));
  try {
    for (const sub of ["pr", "out"]) mkdirSync(join(dir, sub));
    const patch = join(dir, "pr", "diff.patch");
    const fd = openSync(patch, "w");
    try {
      const result = spawnSync("git", ["diff", "--no-color", "--no-ext-diff", "--no-textconv", `${base}..${head}`], {
        cwd: repo, encoding: "utf8", stdio: ["ignore", fd, "pipe"],
      });
      if (result.status !== 0) throw new Error(`git diff failed: ${result.error?.message ?? result.stderr}`);
    } finally {
      closeSync(fd);
    }
    if (!statSync(patch).size) throw new UsageError("there are no changes against the merge-base");
    writeFileSync(join(dir, "pr", "pr.json"), `${JSON.stringify(pr, null, 2)}\n`);
    if (priorText !== undefined) writeFileSync(join(dir, "pr", "prior.json"), priorText);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return { dir };
}

let activeChild: ChildProcess | null = null;
let interrupted: NodeJS.Signals | null = null;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    interrupted ??= signal;
    const child = activeChild;
    child?.kill(signal);
    // A child that ignores graceful termination must not prevent cleanup.
    const timer = setTimeout(() => { if (child && activeChild === child) child.kill("SIGKILL"); }, 2_000);
    timer.unref();
  });
}

/** Both modes read a stable committed tree, without the caller's ignored files. */
async function withWorktree(repo: string, head: string, keep: boolean, review: (path: string) => Promise<number>): Promise<number> {
  const worktree = mkdtempSync(join(tmpdir(), "rev-local-"));
  let added = false;
  try {
    git(["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", worktree, head], repo);
    added = true;
    if (keep) log(`keeping review checkout at ${worktree}`);
    return await review(worktree);
  } finally {
    if (!keep || !added) {
      const removed = spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: repo, encoding: "utf8" });
      if (removed.status !== 0) {
        if (!added) rmSync(worktree, { recursive: true, force: true });
        else log(`could not remove review checkout ${worktree}: ${removed.stderr?.trim()}`);
      }
    }
  }
}

/**
 * Starts the reviewer and streams its progress, which it writes to stderr.
 *
 * The log is appended as it arrives rather than collected and written at the
 * end: a run that hangs or is interrupted is exactly when the log matters, and
 * a buffer that only lands on exit leaves nothing to read.
 */
function runReviewer(env: Record<string, string>, quiet: boolean): Promise<number> {
  const run = dirname(dirname(env.RB_OUT!));
  const logPath = join(run, "reviewer.log");
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [join(root, "src", "main.ts")], {
      cwd: root,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RB_"))), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChild = child;
    const log = createWriteStream(logPath);
    log.on("error", (error) => { child.kill("SIGKILL"); fail(error); });
    child.stderr.on("data", (chunk: Buffer) => {
      log.write(chunk);
      if (!quiet) process.stderr.write(chunk);
    });
    child.stdout.on("data", (chunk: Buffer) => { log.write(chunk); });
    child.on("error", (error) => { log.end(); fail(error); });
    child.on("close", (code) => {
      activeChild = null;
      log.end(() => done(code ?? 1));
    });
  });
}

interface Detail {
  file: string;
  start_line: number;
  end_line: number;
  severity?: string;
  title?: string;
  detail?: string;
  confirmed?: boolean;
}

function readDetails(dir: string): { findings: Detail[]; decided: unknown[] } {
  const path = join(dir, "out", "details.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { findings?: Detail[]; decided?: unknown[] };
  if (!Array.isArray(parsed.findings)) throw new Error("reviewer did not produce valid details");
  return { findings: parsed.findings, decided: parsed.decided ?? [] };
}

/** Prints the review and returns the same summary used for the exit gate. */
function report(dir: string, meta: Record<string, unknown>, json: boolean): Summary {
  const { findings, decided } = readDetails(dir);
  const summary = summarize(findings);
  const fitPath = join(dir, "out", "fit.json");
  const fit = existsSync(fitPath) ? JSON.parse(readFileSync(fitPath, "utf8")) as { verdict: string; summary: string; question?: string } : null;
  if (json) {
    process.stdout.write(`${JSON.stringify({ meta, findings, decided, fit }, null, 2)}\n`);
    return summary;
  }
  findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.file.localeCompare(b.file));
  process.stdout.write(`\n  ${String(meta.nwo)}  ${String(meta.head).slice(0, 10)} vs ${String(meta.base).slice(0, 10)}\n`);
  process.stdout.write(`  ${summary.total} finding(s) — ${summary.high} high, ${summary.medium} medium, ${summary.low} low\n\n`);
  for (const finding of findings) {
    const where = finding.end_line !== finding.start_line ? `${finding.file}:${finding.start_line}-${finding.end_line}` : `${finding.file}:${finding.start_line}`;
    process.stdout.write(`  ${String(finding.severity ?? "?").toUpperCase().padEnd(6)} ${where}  ${finding.title ?? ""}\n`);
    for (const line of (finding.detail ?? "").split("\n")) process.stdout.write(`         ${line}\n`);
    if (finding.confirmed === false) process.stdout.write("         (kept unverified; verification was lenient)\n");
    process.stdout.write("\n");
  }
  if (fit) process.stdout.write(`  Fit: ${fit.verdict}. ${fit.summary}${fit.question ? `\n  ${fit.question}` : ""}\n`);
  if (decided.length) process.stdout.write(`  ${decided.length} earlier finding(s) suppressed by prior decisions\n`);
  return summary;
}

function severityRank(severity: string | undefined): number {
  if (severity === "high") return 0;
  if (severity === "medium") return 1;
  return 2;
}

async function branchMode(options: LocalOptions, settings: Settings): Promise<number> {
  const repo = repoRoot(options.repo);
  const dirty = git(["status", "--porcelain"], repo);
  if (dirty) throw new UsageError(`working tree has uncommitted changes; commit or discard them before reviewing HEAD: ${dirty.split("\n")[0]}`);
  const head = sha(repo, "HEAD");
  const baseRef = options.base ?? defaultBase(repo);
  const base = mergeBase(repo, baseRef, head);
  if (base === head) throw new UsageError(`HEAD is ${baseRef}; switch to the branch you want reviewed`);

  const nwo = repoName(git(["config", "--get", `remote.${remoteName(repo)}.url`], repo, true), "checkout");
  const title = git(["log", "--format=%s", "-1", head], repo);
  const run = prepareRun(`branch-${head.slice(0, 8)}`,
    { repo: `https://github.com/${nwo}`, nwo, pr_number: options.prNumber, base, head, title: `[branch] ${title}`, body: "" },
    repo, base, head, options.prior);
  return withWorktree(repo, head, options.keep, (snapshot) => finish(options, settings, run, { repo: snapshot, base, head, nwo, number: options.prNumber }));
}

async function prMode(options: LocalOptions, settings: Settings): Promise<number> {
  const repo = repoRoot(options.repo);
  const number = options.number!;
  // Let gh honor its configured default (often upstream in a fork clone),
  // then fetch from that same repository rather than an unrelated origin.
  const viewed = spawnSync("gh", ["pr", "view", String(number), "--json", "url,baseRefOid,headRefOid,title,body"], {
    cwd: repo, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  if (viewed.status !== 0) throw new Error(`gh could not read pull request ${number}: ${viewed.error?.message ?? viewed.stderr?.trim()}`);
  const pr = JSON.parse(viewed.stdout) as { url: string; headRefOid: string; baseRefOid: string; title: string; body: string | null };
  const nwo = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+$/.exec(pr.url)?.[1];
  if (!nwo) throw new Error("gh returned a pull request outside github.com");
  const remote = git(["remote"], repo).split("\n").filter(Boolean).find(name =>
    repoName(git(["remote", "get-url", name], repo), "checkout") === nwo,
  ) ?? `https://github.com/${nwo}.git`;
  for (const commit of [pr.headRefOid, pr.baseRefOid]) {
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new UsageError("gh returned an invalid commit");
    if (spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: repo }).status !== 0) {
      git(["fetch", "--quiet", remote, commit], repo);
    }
  }
  const head = sha(repo, pr.headRefOid);
  const base = mergeBase(repo, options.base ? sha(repo, options.base) : pr.baseRefOid, head);
  const run = prepareRun(`pr-${number}-${head.slice(0, 8)}`,
    { repo: `https://github.com/${nwo}`, nwo, pr_number: number, base, head, title: pr.title, body: pr.body ?? "" },
    repo, base, head, options.prior);
  return withWorktree(repo, head, options.keep, (snapshot) => finish(options, settings, run, { repo: snapshot, base, head, nwo, number }));
}

async function finish(
  options: LocalOptions,
  settings: Settings,
  run: Run,
  ctx: { repo: string; base: string; head: string; nwo: string; number: number },
): Promise<number> {
  const env = buildReviewEnv({ nwo: ctx.nwo, number: ctx.number, base: ctx.base, head: ctx.head, repoDir: ctx.repo, runDir: run.dir, settings });
  if (process.env.RB_MODEL_BASE_URL) env.RB_MODEL_BASE_URL = process.env.RB_MODEL_BASE_URL;
  if (process.env.RB_FALLBACK_BASE_URL) env.RB_FALLBACK_BASE_URL = process.env.RB_FALLBACK_BASE_URL;
  const meta = {
    nwo: ctx.nwo, base: ctx.base, head: ctx.head, mode: options.command, run: run.dir, settings,
    ...(env.RB_MODEL_BASE_URL ? { modelBaseUrl: env.RB_MODEL_BASE_URL } : {}),
    ...(env.RB_FALLBACK_BASE_URL ? { fallbackBaseUrl: env.RB_FALLBACK_BASE_URL } : {}),
  };
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ meta, env }, null, 2)}\n`);
    return 0;
  }
  const code = await runReviewer(env, options.quiet);
  // A run that produced no review must not be printed as a review with no
  // findings: that would claim the change is clean when nothing was checked.
  if (code !== 0) {
    const log_path = join(run.dir, "reviewer.log");
    const last = existsSync(log_path) ? readFileSync(log_path, "utf8").trim().split("\n").pop() : "";
    log(`the reviewer failed${last ? `: ${last}` : ""}; see ${log_path}`);
    return 1;
  }
  const summary = report(run.dir, meta, options.json);
  if (reaches(summary, options.failOn)) {
    log(`${options.failOn} severity reached (high ${summary.high}, medium ${summary.medium}, low ${summary.low})`);
    return 2;
  }
  return 0;
}

function doctor(): number {
  let ok = true;
  process.stdout.write("local: doctor\n");
  const major = Number(process.versions.node.split(".")[0]);
  process.stdout.write(`  node      ${process.versions.node} ${major >= 24 ? "ok" : "needs >= 24"}\n`);
  if (major < 24) ok = false;
  for (const [label, command, args] of [
    ["git", "git", ["--version"]],
    ["gh", "gh", ["--version"]],
  ] as const) {
    const found = spawnSync(command, [...args], { encoding: "utf8" });
    process.stdout.write(`  ${label.padEnd(9)} ${found.status === 0 ? found.stdout.split("\n")[0] : "missing"}${label === "gh" ? " (PR mode only)" : ""}\n`);
    if (label === "git" && found.status !== 0) ok = false;
  }
  const settings = availableSettings(root);
  process.stdout.write(`  settings  ${settings.size} RB_CONFIG_* setting(s)\n`);
  if (process.env.RB_CONFIG_ENGINE?.trim() === "claude-code") {
    const how = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() ? "CLAUDE_CODE_OAUTH_TOKEN" : process.env.ANTHROPIC_API_KEY?.trim() ? "ANTHROPIC_API_KEY" : null;
    const status = how ? null : spawnSync("claude", ["auth", "status"], { encoding: "utf8" });
    let signedIn = Boolean(how);
    try {
      if (status) signedIn = JSON.parse(status.stdout).loggedIn === true;
    } catch {
      signedIn = status?.status === 0;
    }
    process.stdout.write(`  claude    ${how ?? (signedIn ? "claude CLI login" : "not signed in (run claude auth login, or set CLAUDE_CODE_OAUTH_TOKEN)")}\n`);
    const fallback = process.env.RB_CONFIG_FALLBACK?.trim();
    if (fallback && fallback !== "off") process.stdout.write(`  fallback  ${fallback} ${process.env.CMD_API_KEY ? "key present" : "CMD_API_KEY absent"}\n`);
    if (!signedIn && !(fallback && fallback !== "off" && process.env.CMD_API_KEY)) ok = false;
  } else {
    process.stdout.write(`  api key   ${process.env.OPENROUTER_API_KEY ? "present" : "absent (export OPENROUTER_API_KEY or use node --env-file with a trusted file)"}\n`);
    if (!process.env.OPENROUTER_API_KEY) ok = false;
  }
  process.stdout.write(`  runs      ${join(root, "runs", "local")}\n`);
  return ok ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (options.command === "doctor") return doctor();
  const settings = effectiveSettings(options, availableSettings(root), process.env);
  return options.command === "branch" ? branchMode(options, settings) : prMode(options, settings);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    log(error.message);
    process.exitCode = 2;
  } else {
    log(`failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} finally {
  // A signal received while spawnSync was running is delivered after it returns.
  await new Promise<void>(done => setImmediate(done));
  if (interrupted) process.exitCode = interrupted === "SIGINT" ? 130 : 143;
}
