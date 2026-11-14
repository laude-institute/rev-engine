// Tests for the local runner's pure parts: argument parsing, the environment it
// builds for the reviewer, and the gate arithmetic.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  UsageError, buildReviewEnv, effectiveSettings, envNameOf, parseArgs, reaches,
  repoName, summarize,
} from "../scripts/local/layout.ts";

const ALL = new Set(["model", "mode", "min_severity"]);

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

test("unknown flags are rejected rather than ignored", () => {
  assert.throws(() => parseArgs(["branch", "--nonsense", "1"]), UsageError);
  assert.throws(() => parseArgs(["branch", "--set", "noequals"]), UsageError);
  assert.throws(() => parseArgs(["branch", "--base"]), UsageError);
});

test("--set carries a setting the runner has never heard of, for a checkout that defines it", () => {
  // Which settings exist is read from the checkout, not from a list kept here,
  // so a setting added to the reviewer later needs no change to the parser.
  const options = parseArgs(["branch", "--set", "hypothetical_switch=on"]);
  assert.equal(options.settings.hypothetical_switch, "on");
  assert.equal(effectiveSettings(options, new Set(["hypothetical_switch"])).hypothetical_switch, "on");
});

test("a setting can be set through --set as well as its own flag", () => {
  assert.equal(parseArgs(["branch", "--set", "model=opus"]).settings.model, "opus");
  assert.equal(parseArgs(["branch", "--set", "second_look=sweep"]).settings.second_look, "sweep");
});

test("no setting is passed unless it was asked for", () => {
  const settings = effectiveSettings(parseArgs(["branch"]), ALL);
  assert.deepEqual(settings, {});
});

test("a setting this checkout does not define is refused before the run starts", () => {
  const options = parseArgs(["branch", "--min-severity", "high"]);
  assert.throws(() => effectiveSettings(options, new Set(["model", "mode"])), UsageError);
});

test("a setting the checkout defines is passed through", () => {
  assert.equal(effectiveSettings(parseArgs(["branch", "--min-severity", "high"]), ALL).min_severity, "high");
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
  assert.equal(env.RB_CONFIG_MODE, undefined);
  for (const key of Object.keys(env)) assert.match(key, /^RB_/, `${key} is not an RB_ variable`);
});

test("a setting this file has never heard of still reaches the reviewer", () => {
  const env = buildReviewEnv({
    nwo: "o/r", number: 1, base: "a", head: "b", repoDir: "/c", runDir: "/r",
    settings: { hypothetical_switch: "on" },
  });
  assert.equal(env.RB_CONFIG_HYPOTHETICAL_SWITCH, "on");
});

test("a setting name maps to the contract's variable name", () => {
  assert.equal(envNameOf("min_severity"), "RB_CONFIG_MIN_SEVERITY");
  assert.equal(envNameOf("model"), "RB_CONFIG_MODEL");
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

test("inherited settings are validated and CLI settings take precedence", () => {
  const options = parseArgs(["branch", "--model", "explicit"]);
  assert.deepEqual(effectiveSettings(options, ALL, { RB_CONFIG_MODEL: "inherited", RB_CONFIG_MODE: "agent" }), { model: "explicit", mode: "agent" });
  assert.throws(() => effectiveSettings(options, ALL, { RB_CONFIG_TYPO: "on" }), UsageError);
});

test("GitHub URL parsing checks the host and supports SSH URLs", () => {
  assert.equal(repoName("ssh://git@github.com/owner/repo.git", "x"), "owner/repo");
  assert.equal(repoName("https://github.com.example.org/owner/repo", "x"), "local/x");
  assert.equal(repoName("https://gitlab.com/github.com/repo", "x"), "local/x");
});

test("PR mode refuses extra numbers instead of reviewing the wrong argument", () => {
  assert.throws(() => parseArgs(["pr", "1", "2"]), UsageError);
});
