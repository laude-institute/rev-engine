// Tests for the local runner's pure parts: argument parsing, the environment it
// builds for the reviewer, and the gate arithmetic.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  UsageError, buildReviewEnv, effectiveSettings, parseArgs, reaches,
  repoName, summarize,
} from "../scripts/local/layout.ts";

const ALL = new Set(["engine", "model", "mode", "min_severity"]);

test("a setting flag sets the container setting of the same name", () => {
  const options = parseArgs(["branch", "--min-severity", "high", "--max-turns", "12"]);
  assert.equal(options.settings.min_severity, "high");
  assert.equal(options.settings.max_turns, "12");
});

test("pr mode requires a pull request number", () => {
  assert.throws(() => parseArgs(["pr"]), UsageError);
  assert.throws(() => parseArgs(["pr", "abc"]), UsageError);
  assert.equal(parseArgs(["pr", "1938"]).number, 1938);
});

test("unknown flags and settings are rejected rather than ignored", () => {
  assert.throws(() => parseArgs(["branch", "--nonsense", "1"]), UsageError);
  assert.throws(() => parseArgs(["branch", "--set", "nonsense=1"]), UsageError);
  assert.throws(() => parseArgs(["branch", "--set", "noequals"]), UsageError);
  assert.throws(() => parseArgs(["branch", "--base"]), UsageError);
});

test("a setting can be set through --set as well as its own flag", () => {
  assert.equal(parseArgs(["branch", "--set", "model=opus"]).settings.model, "opus");
  assert.equal(parseArgs(["branch", "--set", "second_look=sweep"]).settings.second_look, "sweep");
});

test("--engine auto leaves the engine unset so the branch default applies", () => {
  const settings = effectiveSettings(parseArgs(["branch"]), ALL);
  assert.equal("engine" in settings, false);
});

test("--engine is refused when the checkout has no engine setting", () => {
  const options = parseArgs(["branch", "--engine", "claude-code"]);
  assert.throws(() => effectiveSettings(options, new Set(["model"])), UsageError);
});

test("--engine is passed through when the branch carries it", () => {
  assert.equal(effectiveSettings(parseArgs(["branch", "--engine", "api"]), ALL).engine, "api");
});

test("the reviewer environment names local paths and nothing else", () => {
  const env = buildReviewEnv({
    nwo: "owner/repo", number: 7, base: "a".repeat(40), head: "b".repeat(40),
    repoDir: "/tmp/checkout", runDir: "/tmp/run", settings: { model: "haiku" },
  });
  assert.equal(env.RB_REPO, "/tmp/checkout");
  assert.equal(env.RB_DIFF, "/tmp/run/pr/diff.patch");
  assert.equal(env.RB_OUT, "/tmp/run/out/findings.json");
  assert.equal(env.RB_PR_NUMBER, "7");
  assert.equal(env.RB_CONFIG_MODEL, "haiku");
  assert.equal(env.RB_CONFIG_ENGINE, undefined);
  for (const key of Object.keys(env)) assert.match(key, /^RB_/, `${key} is not an RB_ variable`);
});

test("empty settings are omitted rather than sent blank", () => {
  const env = buildReviewEnv({
    nwo: "o/r", number: 1, base: "a", head: "b", repoDir: "/c", runDir: "/r", settings: { model: "", mode: "agent" },
  });
  assert.equal(env.RB_CONFIG_MODEL, undefined);
  assert.equal(env.RB_CONFIG_MODE, "agent");
});

test("a clone URL becomes owner/repo, and a local remote does not pretend to be one", () => {
  assert.equal(repoName("https://github.com/owner/repo.git", "x"), "owner/repo");
  assert.equal(repoName("git@github.com:owner/repo.git", "x"), "owner/repo");
  assert.equal(repoName(null, "checkout"), "local/checkout");
  // A path remote is not an owner/repository, so it must not be reported as one.
  assert.equal(repoName("/srv/git/repo", "checkout"), "local/checkout");
  assert.equal(repoName("https://gitlab.com/owner/repo", "checkout"), "local/checkout");
});

test("findings are counted by severity, and an unexpected severity is not dropped", () => {
  const summary = summarize([{ severity: "high" }, { severity: "medium" }, { severity: "low" }, {}]);
  assert.deepEqual(summary, { high: 1, medium: 1, low: 2, total: 4 });
});

test("the gate fires at the threshold it is given, and never for none", () => {
  const summary = summarize([{ severity: "medium" }]);
  assert.equal(reaches(summary, "none"), false);
  assert.equal(reaches(summary, "high"), false);
  assert.equal(reaches(summary, "medium"), true);
  assert.equal(reaches(summary, "low"), true);
});
