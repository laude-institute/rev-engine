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
  for (const path of [join(runner, "scripts/local"), join(runner, "src"), repo, bin]) mkdirSync(path, { recursive: true });
  for (const file of ["scripts/local.ts", "scripts/local/layout.ts", "src/config.ts"]) copyFileSync(join(source, file), join(runner, file));
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
    writeFileSync(join(bin, "gh"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(metadata))});\n`);
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

test("SIGTERM cleans up the child and detached worktree", async t => {
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
  child.kill("SIGTERM");
  const [code] = await completed;
  assert.equal(code, 143);
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
