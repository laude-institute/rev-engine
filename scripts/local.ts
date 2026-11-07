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
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  UsageError, buildReviewEnv, effectiveSettings, parseArgs, reaches,
  repoName, summarize, type LocalOptions, type Settings,
} from "./local/layout.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const log = (message: string): void => console.error(`local: ${message}`);

/** A git command's trimmed output, or a readable failure. */
function git(args: string[], cwd: string, allowFailure = false): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    const detail = (result.stderr || result.stdout).trim().split("\n").pop() ?? String(result.status);
    throw new UsageError(`git ${args[0]} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function repoRoot(path: string): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: path, encoding: "utf8" });
  if (result.status !== 0) throw new UsageError(`${path} is not inside a git working tree`);
  return result.stdout.trim();
}

function remoteName(repo: string): string {
  const names = git(["remote"], repo, true).split("\n").filter(Boolean);
  return names.includes("origin") ? "origin" : (names[0] ?? "origin");
}

/** The branch a pull request would target: the remote's HEAD, then the usual names. */
function defaultBase(repo: string): string {
  const symbolic = git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], repo, true);
  if (symbolic) return symbolic.replace(/^refs\/remotes\//, "");
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (spawnSync("git", ["rev-parse", "--verify", "--quiet", candidate], { cwd: repo }).status === 0) return candidate;
  }
  throw new UsageError("cannot tell the base branch; pass --base <ref>");
}

function sha(repo: string, ref: string): string {
  const value = git(["rev-parse", ref], repo, true);
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
  const source = readFileSync(join(repo, "src", "config.ts"), "utf8");
  const available = new Set<string>();
  // A setting is read either as env.RB_CONFIG_X or by name through a helper,
  // such as integer(env, "RB_CONFIG_X", ...), so both spellings are collected.
  for (const match of source.matchAll(/RB_CONFIG_([A-Z0-9_]+)/g)) {
    available.add(match[1]!.toLowerCase());
  }
  return available;
}

interface Run {
  dir: string;
  prJson: Record<string, unknown>;
}

/** Writes the pull request the reviewer expects to find mounted. */
function prepareRun(label: string, pr: Record<string, unknown>, diff: string): Run {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const slug = label.replace(/[^A-Za-z0-9._-]+/g, "-");
  const dir = join(root, "runs", "local", `${stamp}-${slug}`);
  for (const sub of ["pr", "out"]) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, "pr", "diff.patch"), diff.endsWith("\n") ? diff : `${diff}\n`);
  writeFileSync(join(dir, "pr", "pr.json"), `${JSON.stringify(pr, null, 2)}\n`);
  return { dir, prJson: pr };
}

/**
 * Starts the reviewer and streams its progress, which it writes to stderr.
 *
 * The log is appended as it arrives rather than collected and written at the
 * end: a run that hangs or is interrupted is exactly when the log matters, and
 * a buffer that only lands on exit leaves nothing to read.
 */
function runReviewer(env: Record<string, string>, quiet: boolean): Promise<number> {
  const run = env.RB_OUT!.replace(/\/out\/findings\.json$/, "");
  const logPath = join(run, "reviewer.log");
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [join(root, "src", "main.ts")], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const log = createWriteStream(logPath);
    child.stderr.on("data", (chunk: Buffer) => {
      log.write(chunk);
      if (!quiet) process.stderr.write(chunk);
    });
    child.stdout.on("data", (chunk: Buffer) => { log.write(chunk); });
    child.on("error", (error) => { log.end(); fail(error); });
    child.on("close", (code) => { log.end(); done(code ?? 1); });
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
  if (!existsSync(path)) return { findings: [], decided: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { findings?: Detail[]; decided?: unknown[] };
    return { findings: parsed.findings ?? [], decided: parsed.decided ?? [] };
  } catch {
    return { findings: [], decided: [] };
  }
}

/** Prints the review and returns the display-only finding total. */
function report(dir: string, meta: Record<string, unknown>, json: boolean): number {
  const { findings, decided } = readDetails(dir);
  const summary = summarize(findings);
  if (json) {
    process.stdout.write(`${JSON.stringify({ meta, findings, decided }, null, 2)}\n`);
    return summary.total;
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
  if (decided.length) process.stdout.write(`  ${decided.length} earlier finding(s) suppressed by prior decisions\n`);
  return summary.total;
}

function severityRank(severity: string | undefined): number {
  if (severity === "high") return 0;
  if (severity === "medium") return 1;
  return 2;
}

async function branchMode(options: LocalOptions, settings: Settings): Promise<number> {
  const repo = repoRoot(options.repo);
  const dirty = git(["status", "--porcelain"], repo);
  if (dirty) throw new UsageError(`working tree has uncommitted changes; the reviewer reads the tree at head: ${dirty.split("\n")[0]}`);
  const head = sha(repo, "HEAD");
  const baseRef = options.base ?? defaultBase(repo);
  const base = mergeBase(repo, baseRef, head);
  if (base === head) throw new UsageError(`HEAD is ${baseRef}; switch to the branch you want reviewed`);
  const diff = git(["diff", "--no-color", `${base}..${head}`], repo);
  if (!diff) throw new UsageError("the branch has no changes against its merge-base");

  const nwo = repoName(git(["config", "--get", `remote.${remoteName(repo)}.url`], repo, true), "checkout");
  const title = git(["log", "--format=%s", "-1", head], repo);
  const run = prepareRun(`branch-${head.slice(0, 8)}`,
    { repo: `https://github.com/${nwo}`, nwo, pr_number: options.prNumber, base, head, title: `[branch] ${title}`, body: "" },
    diff);
  return finish(options, settings, run, { repo, base, head, nwo, number: options.prNumber });
}

async function prMode(options: LocalOptions, settings: Settings): Promise<number> {
  const repo = repoRoot(options.repo);
  const number = options.number!;
  const viewed = spawnSync("gh", ["pr", "view", String(number), "--json", "baseRefOid,headRefOid,baseRefName,title,body"], { cwd: repo, encoding: "utf8" });
  if (viewed.status !== 0) throw new UsageError(`gh could not read pull request ${number}: ${(viewed.stderr || "").trim()}`);
  const pr = JSON.parse(viewed.stdout) as { headRefOid: string; baseRefName: string; title: string; body: string | null };

  const remote = remoteName(repo);
  let head = pr.headRefOid;
  if (spawnSync("git", ["cat-file", "-e", `${head}^{commit}`], { cwd: repo }).status !== 0) {
    git(["fetch", "--quiet", remote, `pull/${number}/head`], repo);
    head = sha(repo, "FETCH_HEAD");
  }
  const baseRef = options.base ?? pr.baseRefName ?? defaultBase(repo);
  if (spawnSync("git", ["rev-parse", "--verify", "--quiet", baseRef], { cwd: repo }).status !== 0) {
    git(["fetch", "--quiet", remote, baseRef], repo, true);
  }
  const base = mergeBase(repo, baseRef, head);
  const diff = git(["diff", "--no-color", `${base}..${head}`], repo);
  if (!diff) throw new UsageError(`pull request ${number} has no diff against ${baseRef}`);

  // The reviewer reads the tree at head, so it gets a detached worktree and the
  // caller's checkout is left exactly as it was.
  const worktree = mkdtempSync(join(tmpdir(), `rev-local-${number}-`));
  const added = spawnSync("git", ["worktree", "add", "--detach", "--force", worktree, head], { cwd: repo, encoding: "utf8" });
  if (added.status !== 0) throw new UsageError(`git worktree add failed: ${(added.stderr || "").trim()}`);
  try {
    const nwo = repoName(git(["config", "--get", `remote.${remote}.url`], repo, true), "checkout");
    const run = prepareRun(`pr-${number}-${head.slice(0, 8)}`,
      { repo: `https://github.com/${nwo}`, nwo, pr_number: number, base, head, title: pr.title, body: pr.body ?? "" },
      diff);
    return await finish(options, settings, run, { repo: worktree, base, head, nwo, number });
  } finally {
    if (!options.keep) spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: repo });
  }
}

async function finish(
  options: LocalOptions,
  settings: Settings,
  run: Run,
  ctx: { repo: string; base: string; head: string; nwo: string; number: number },
): Promise<number> {
  const env = buildReviewEnv({ nwo: ctx.nwo, number: ctx.number, base: ctx.base, head: ctx.head, repoDir: ctx.repo, runDir: run.dir, settings });
  const meta = { nwo: ctx.nwo, base: ctx.base, head: ctx.head, mode: options.command, run: run.dir, settings };
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
  report(run.dir, meta, options.json);
  const summary = summarize(readDetails(run.dir).findings);
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
    process.stdout.write(`  ${label.padEnd(9)} ${found.status === 0 ? found.stdout.split("\n")[0] : "missing"}\n`);
  }
  const settings = availableSettings(root);
  process.stdout.write(`  settings  ${settings.size} RB_CONFIG_* setting(s)${settings.has("engine") ? ", including engine" : ""}\n`);
  process.stdout.write(`  api key   ${process.env.OPENROUTER_API_KEY ? "present" : "absent (needed unless the branch has another engine)"}\n`);
  process.stdout.write(`  runs      ${join(root, "runs", "local")}\n`);
  return ok ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (options.command === "doctor") return doctor();
  const settings = effectiveSettings(options, availableSettings(root));
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
}
