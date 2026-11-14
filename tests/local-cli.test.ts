import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stub = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const env = process.env;
const out = dirname(env.RB_OUT);
writeFileSync(join(out, 'observed.json'), JSON.stringify({
  repo: env.RB_REPO, ignored: existsSync(join(env.RB_REPO, '.env')),
  model: env.RB_CONFIG_MODEL, transcript: env.RB_TRANSCRIPT_OUT,
  prior: existsSync(env.RB_PRIOR_JSON) ? JSON.parse(readFileSync(env.RB_PRIOR_JSON, 'utf8')) : null,
}));
if (env.FIXTURE_MODE === 'hang') await new Promise(resolve => setTimeout(resolve, 60000));
if (env.FIXTURE_MODE === 'fail') {
  await new Promise(resolve => process.stderr.write('x'.repeat(200000) + '\\nfixture failure tail\\n', resolve));
  process.exitCode = 1;
} else if (env.FIXTURE_MODE !== 'missing') {
  writeFileSync(env.RB_DETAILS_OUT, JSON.stringify({ findings: env.FIXTURE_MODE === 'high' ?
    [{file:'code.txt',start_line:1,end_line:1,severity:'high',title:'Fixture',detail:'Fixture'}] : [] }));
  writeFileSync(join(out, 'fit.json'), JSON.stringify({verdict:'fits',summary:'Fixture fit result'}));
}
`;

function fixture(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "local-cli-test-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runner = join(dir, "runner");
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  for (const path of [join(runner, "scripts/local"), join(runner, "src"), join(runner, "experiments/prototypes/swarm"), repo, bin]) mkdirSync(path, { recursive: true });
  for (const file of ["scripts/local.ts", "scripts/local/layout.ts", "src/config.ts", "src/claude-cli.ts", "experiments/prototypes/swarm/review.ts"]) copyFileSync(join(source, file), join(runner, file));
  writeFileSync(join(runner, "package.json"), '{"type":"module"}');
  writeFileSync(join(runner, "src/main.ts"), stub);
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ""}`, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "main");
  writeFileSync(join(repo, ".gitignore"), ".env\n");
  writeFileSync(join(repo, "code.txt"), "old\n\n");
  git("add", "."); git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-b", "feature");
  writeFileSync(join(repo, "code.txt"), "new\n\n");
  git("commit", "-am", "feature");
  const head = git("rev-parse", "HEAD");
  const cli = (args: string[], extra: Record<string, string> = {}) => spawnSync(process.execPath, [join(runner, "scripts/local.ts"), ...args], {
    cwd: dir, env: { ...env, ...extra }, encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
  });
  const runs = () => readdirSync(join(runner, "runs/local")).map(name => join(runner, "runs/local", name));
  const gh = (metadata: object) => {
    writeFileSync(join(bin, "gh"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ url: "https://github.com/fixture/project/pull/1", ...metadata }))});\n`);
    chmodSync(join(bin, "gh"), 0o755);
    git("remote", "add", "origin", "https://github.com/fixture/project.git");
  };
  return { dir, runner, repo, bin, env, git, base, head, cli, runs, gh };
}

test("branch reviews an isolated commit, passes prior and effective settings, and reports fit", t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, ".env"), "SYNTHETIC=not-a-secret\n");
  const prior = { entries: [{ id: "P1", file: "code.txt", title: "Previous decision", decision: "wrong", round: 1, source: "fixture" }], omitted: 0 };
  writeFileSync(join(f.dir, "prior.json"), JSON.stringify(prior));
  const result = f.cli(["branch", "--repo", f.repo, "--base", "main", "--prior", "prior.json", "--model", "explicit", "--json"], {
    RB_CONFIG_MODEL: "inherited", RB_TRANSCRIPT_OUT: join(f.dir, "outside.json"),
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const observed = JSON.parse(readFileSync(join(report.meta.run, "out/observed.json"), "utf8"));
  assert.notEqual(observed.repo, f.repo);
  assert.equal(observed.ignored, false);
  assert.equal(observed.model, "explicit");
  assert.equal(observed.transcript, undefined);
  assert.deepEqual(observed.prior, prior);
  assert.equal(report.meta.settings.model, "explicit");
  assert.equal(report.fit.summary, "Fixture fit result");
  assert.equal(existsSync(observed.repo), false);
  assert.equal(f.git("status", "--porcelain"), "");
  assert.equal(f.git("rev-parse", "HEAD"), f.head);
  const patch = readFileSync(join(report.meta.run, "pr/diff.patch"), "utf8");
  const raw = spawnSync("git", ["diff", `${f.base}..${f.head}`], { cwd: f.repo, env: f.env, encoding: "utf8" }).stdout;
  assert.equal(patch, raw);
});

test("branch refuses uncommitted files and unknown settings before reviewing", t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, "untracked.txt"), "pending");
  const dirty = f.cli(["branch", "--repo", f.repo, "--base", "main"]);
  assert.equal(dirty.status, 2); assert.match(dirty.stderr, /uncommitted/);
  const bogus = f.cli(["branch", "--repo", f.repo, "--set", "swarm_=on"]);
  assert.equal(bogus.status, 2); assert.match(bogus.stderr, /does not define/);
});

test("PR mode uses exact metadata commits with stale or missing local target branches", t => {
  const f = fixture(t);
  // The previous feature is now already on the target; local main stays stale.
  const target = f.head;
  writeFileSync(join(f.repo, "pr-only.txt"), "PR addition\n");
  f.git("add", "."); f.git("commit", "-m", "PR change");
  const head = f.git("rev-parse", "HEAD");
  f.gh({ headRefOid: head, baseRefOid: target, baseRefName: "main", title: "Fixture", body: "" });
  for (const missing of [false, true]) {
    if (missing) f.git("branch", "-D", "main");
    const result = f.cli(["pr", "1", "--repo", f.repo, "--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.meta.base, target);
    assert.equal(report.meta.head, head);
    const patch = readFileSync(report.env.RB_DIFF, "utf8");
    assert.match(patch, /pr-only.txt/); assert.doesNotMatch(patch, /code.txt/);
  }
});

test("large patches are complete and simultaneous runs get separate directories", t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, "large.txt"), "new source contents\n".repeat(80000));
  f.git("add", "."); f.git("commit", "-m", "large diff");
  const preload = join(f.dir, "clock.mjs");
  writeFileSync(preload, 'const RealDate=Date; globalThis.Date=class extends RealDate { toISOString(){return "2026-01-01T00:00:00.000Z";} };');
  const dirs: string[] = [];
  for (let i = 0; i < 2; i++) {
    const result = spawnSync(process.execPath, ["--import", preload, join(f.runner, "scripts/local.ts"), "branch", "--repo", f.repo, "--base", "main", "--dry-run"], { cwd: f.dir, env: f.env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    dirs.push(report.meta.run);
    const patch = readFileSync(report.env.RB_DIFF, "utf8");
    assert.ok(patch.length > 1024 * 1024);
    const raw = spawnSync("git", ["diff", "main..HEAD"], { cwd: f.repo, env: f.env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).stdout;
    assert.equal(patch, raw);
  }
  assert.notEqual(dirs[0], dirs[1]);
});

test("failure waits for the log and never prints a clean review; the severity gate uses the findings", t => {
  const f = fixture(t);
  const args = ["branch", "--repo", f.repo, "--base", "main", "--json", "--quiet"];
  const failed = f.cli(args, { FIXTURE_MODE: "fail" });
  assert.equal(failed.status, 1); assert.equal(failed.stdout, "");
  assert.match(failed.stderr, /fixture failure tail/);
  const missing = f.cli(args, { FIXTURE_MODE: "missing" });
  assert.equal(missing.status, 1); assert.equal(missing.stdout, "");
  const high = f.cli([...args, "--fail-on", "high"], { FIXTURE_MODE: "high" });
  assert.equal(high.status, 2); assert.equal(JSON.parse(high.stdout).findings.length, 1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) test(`${signal} cleans up the child and detached worktree`, { timeout: 10_000 }, async t => {
  const f = fixture(t);
  const child = spawn(process.execPath, [join(f.runner, "scripts/local.ts"), "branch", "--repo", f.repo, "--base", "main", "--quiet"], {
    cwd: f.dir, env: { ...f.env, FIXTURE_MODE: "hang" }, stdio: "ignore",
  });
  const completed = once(child, "close");
  t.after(() => { child.kill("SIGKILL"); });
  let observed: { repo: string } | undefined;
  for (let attempt = 0; attempt < 200; attempt++) {
    const parent = join(f.runner, "runs/local");
    const path = existsSync(parent) ? f.runs().map(run => join(run, "out/observed.json")).find(existsSync) : undefined;
    if (path) { observed = JSON.parse(readFileSync(path, "utf8")); break; }
    await delay(10);
  }
  assert.ok(observed, "reviewer started");
  child.kill(signal);
  const [code] = await completed;
  assert.equal(code, signal === "SIGINT" ? 130 : 143);
  assert.equal(existsSync(observed.repo), false);
  assert.doesNotMatch(f.git("worktree", "list", "--porcelain"), /rev-local-/);
});

test("doctor fails without git and reports gh as optional for branch mode", t => {
  const f = fixture(t);
  const result = f.cli(["doctor"], { PATH: f.bin, OPENROUTER_API_KEY: "synthetic" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /git\s+missing/);
  assert.match(result.stdout, /gh\s+missing \(PR mode only\)/);
});

test("doctor checks the claude login when the engine is set with --set", t => {
  const f = fixture(t);
  const claude = (loggedIn: boolean) => {
    writeFileSync(join(f.bin, "claude"), `#!${process.execPath}\nif (process.argv.includes("--version")) console.log("2.1.325");\nelse console.log(JSON.stringify({ loggedIn: ${loggedIn} }));\n`);
    chmodSync(join(f.bin, "claude"), 0o755);
  };
  claude(true);
  let result = f.cli(["doctor", "--set", "engine=claude-code"]);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /claude\s+claude CLI login/);
  assert.doesNotMatch(result.stdout, /api key/);

  result = f.cli(["doctor"], { RB_CONFIG_ENGINE: "claude-code", CLAUDE_CODE_OAUTH_TOKEN: "synthetic" });
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /claude\s+CLAUDE_CODE_OAUTH_TOKEN/);

  claude(false);
  result = f.cli(["doctor", "--set", "engine=claude-code"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /claude\s+not signed in/);
  // A fallback with its key lets the review run anyway.
  result = f.cli(["doctor", "--set", "engine=claude-code", "--set", "fallback=vendor/fallback"], { CMD_API_KEY: "synthetic" });
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /fallback\s+vendor\/fallback key present/);
  // A fallback without its key fails the review, so doctor fails too, even when claude is signed in.
  claude(true);
  result = f.cli(["doctor", "--set", "engine=claude-code", "--set", "fallback=vendor/fallback"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /fallback\s+vendor\/fallback CMD_API_KEY absent/);

  rmSync(join(f.bin, "claude"));
  result = f.cli(["doctor", "--set", "engine=claude-code"], { PATH: `${f.bin}:${dirname(spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim())}`, CLAUDE_CODE_OAUTH_TOKEN: "synthetic" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /claude\s+missing/);
});

test("PR mode fetches the exact missing head and base from its selected remote", t => {
  const f = fixture(t);
  const remote = join(f.dir, "remote.git");
  const cloned = spawnSync("git", ["clone", "--bare", f.repo, remote], { env: f.env, encoding: "utf8" });
  assert.equal(cloned.status, 0, cloned.stderr);
  // Commit only in a separate checkout, so the original repository must fetch.
  const author = join(f.dir, "author");
  assert.equal(spawnSync("git", ["clone", remote, author], { env: f.env }).status, 0);
  writeFileSync(join(author, "remote-only.txt"), "remote change\n");
  for (const args of [["add", "."], ["commit", "-m", "remote base"], ["push", "origin", "HEAD"]]) {
    const result = spawnSync("git", args, { cwd: author, env: f.env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: author, env: f.env, encoding: "utf8" }).stdout.trim();
  writeFileSync(join(author, "pr-only.txt"), "PR change\n");
  for (const args of [["add", "."], ["commit", "-m", "remote head"], ["push", "origin", "HEAD"]]) {
    assert.equal(spawnSync("git", args, { cwd: author, env: f.env }).status, 0);
  }
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: author, env: f.env, encoding: "utf8" }).stdout.trim();
  f.gh({ headRefOid: head, baseRefOid: base, title: "Fixture", body: "" });
  f.git("config", `url.${remote}.insteadOf`, "https://github.com/fixture/project.git");
  const result = f.cli(["pr", "1", "--repo", f.repo, "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).meta.base, base);
  assert.equal(JSON.parse(result.stdout).meta.head, head);
});

test("--keep retains only the isolated review checkout and reports its location", t => {
  const f = fixture(t);
  const result = f.cli(["branch", "--repo", f.repo, "--base", "main", "--dry-run", "--keep"]);
  assert.equal(result.status, 0, result.stderr);
  const repo = JSON.parse(result.stdout).env.RB_REPO;
  try {
    assert.ok(existsSync(repo));
    assert.match(result.stderr, /keeping review checkout/);
    assert.equal(spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, env: f.env, encoding: "utf8" }).stdout.trim(), f.head);
  } finally {
    f.git("worktree", "remove", "--force", repo);
  }
});

test("branch defaults use the selected remote and refuse reviewing the base itself", t => {
  const f = fixture(t);
  const local = f.cli(["branch", "--repo", f.repo, "--dry-run"]);
  assert.equal(local.status, 0, local.stderr);
  assert.equal(JSON.parse(local.stdout).meta.base, f.base);
  f.git("remote", "add", "upstream", "https://github.com/fixture/project.git");
  f.git("update-ref", "refs/remotes/upstream/trunk", f.head);
  f.git("symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/trunk");
  const equal = f.cli(["branch", "--repo", f.repo, "--dry-run"]);
  assert.equal(equal.status, 2); assert.match(equal.stderr, /HEAD is upstream\/trunk/);
  writeFileSync(join(f.repo, "later.txt"), "later change"); f.git("add", "."); f.git("commit", "-m", "later");
  const remote = f.cli(["branch", "--repo", f.repo, "--dry-run"]);
  assert.equal(remote.status, 0, remote.stderr);
  assert.equal(JSON.parse(remote.stdout).meta.base, f.head);
});

test("swarm settings are accepted from both flags and the environment", t => {
  const f = fixture(t);
  const result = f.cli(["branch", "--repo", f.repo, "--base", "main", "--dry-run", "--set", "swarm_target=60"], { RB_CONFIG_SWARM_EVIDENCE: "on" });
  assert.equal(result.status, 0, result.stderr);
  const settings = JSON.parse(result.stdout).meta.settings;
  assert.equal(settings.swarm_target, "60"); assert.equal(settings.swarm_evidence, "on");
});

test("PR metadata from gh's upstream default is not overridden by a fork origin", t => {
  const f = fixture(t);
  f.gh({ url: "https://github.com/upstream/project/pull/1", headRefOid: f.head, baseRefOid: f.base, title: "Fixture", body: "" });
  f.git("remote", "add", "upstream", "git@github.com:upstream/project.git");
  // Have the gh stub reject --repo, which would override its configured default.
  const ghPath = join(f.bin, "gh");
  writeFileSync(ghPath, readFileSync(ghPath, "utf8").replace("process.stdout.write", 'if (process.argv.includes("--repo")) process.exit(9); process.stdout.write'));
  const result = f.cli(["pr", "1", "--repo", f.repo, "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).meta.nwo, "upstream/project");
});

test("invalid prior input is a usage error and leaves no partial run", t => {
  const f = fixture(t);
  writeFileSync(join(f.dir, "bad.json"), "invalid json");
  writeFileSync(join(f.dir, "shape.json"), "{}");
  for (const prior of ["absent.json", "bad.json", "shape.json"]) {
    const result = f.cli(["branch", "--repo", f.repo, "--base", "main", "--prior", prior, "--dry-run"]);
    assert.equal(result.status, 2); assert.match(result.stderr, /cannot use --prior/);
  }
  assert.equal(existsSync(join(f.runner, "runs/local")), false);
  // A history with commits but no net diff also leaves no run behind.
  writeFileSync(join(f.repo, "code.txt"), "old\n\n"); f.git("commit", "-am", "revert");
  const empty = f.cli(["branch", "--repo", f.repo, "--base", "main", "--dry-run"]);
  assert.equal(empty.status, 2); assert.deepEqual(f.runs(), []);
});

test("a failed gh invocation is a run failure, not a finding or usage exit", t => {
  const f = fixture(t);
  writeFileSync(join(f.bin, "gh"), `#!${process.execPath}\nconsole.error('fixture auth failure');process.exitCode=1;`);
  chmodSync(join(f.bin, "gh"), 0o755);
  const result = f.cli(["pr", "1", "--repo", f.repo, "--dry-run"]);
  assert.equal(result.status, 1); assert.match(result.stderr, /fixture auth failure/);
  assert.equal(result.stdout, "");
});

test("an interrupt during synchronous git setup retains the signal exit code", { timeout: 10_000 }, async t => {
  const f = fixture(t);
  const realGit = f.env.PATH!.split(":").map(dir => join(dir, "git")).find(existsSync)!;
  const marker = join(f.dir, "in-diff");
  const wrapper = `#!${process.execPath}
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
if (process.argv[2] === 'diff') { writeFileSync(${JSON.stringify(marker)}, 'ready'); setTimeout(()=>{},60000); }
else { const r=spawnSync(${JSON.stringify(realGit)},process.argv.slice(2),{stdio:'inherit'});process.exitCode=r.status??1; }
`;
  writeFileSync(join(f.bin, "git"), wrapper); chmodSync(join(f.bin, "git"), 0o755);
  const child = spawn(process.execPath, [join(f.runner, "scripts/local.ts"), "branch", "--repo", f.repo, "--base", "main", "--dry-run"], { cwd: f.dir, env: f.env, detached: true, stdio: "ignore" });
  const completed = once(child, "close");
  t.after(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } });
  for (let i=0; i<200 && !existsSync(marker); i++) await delay(10);
  assert.ok(existsSync(marker), "git diff started");
  process.kill(-child.pid!, "SIGINT");
  const [code] = await completed;
  assert.equal(code, 130);
  assert.deepEqual(f.runs(), []);
});
