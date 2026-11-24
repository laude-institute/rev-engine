import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

const action = readFileSync(new URL("../action.yml", import.meta.url), "utf8");
const step = action.split("    - name: Check who asked\n")[1]!.split("    # The token is not kept")[0]!;
const script = step.split("      run: |\n")[1]!.split("\n").map(line => line.replace(/^        /, "")).join("\n");
const defaultBots = action.match(/^  allowed-bots:\n(?:    .*\n)*?    default: (.*)$/m)![1]!;

// Runs the step with a fake gh that answers the pull request and the collaborator permission.
function ask(t: TestContext, opts: { event: string; actor: string; permission?: string; headRepo?: string; bots?: string; allowForks?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "rev-ask-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "bin"));
  const gh = join(dir, "bin", "gh");
  writeFileSync(gh, `#!${process.execPath}
const path = process.argv[3] ?? "";
if (path.includes("/collaborators/")) { require("node:fs").appendFileSync(process.env.ASKED, path + "\\n"); console.log(process.env.PERMISSION); }
else console.log(JSON.stringify({ title: "t", body: "b", head: { repo: { full_name: process.env.HEAD_REPO }, sha: "h" }, base: { sha: "b" } }));
`);
  chmodSync(gh, 0o755);
  const output = join(dir, "output");
  const asked = join(dir, "asked");
  writeFileSync(output, "");
  writeFileSync(asked, "");
  const scriptPath = join(dir, "ask.sh");
  writeFileSync(scriptPath, script);
  const result = spawnSync("bash", [scriptPath], {
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`, RUNNER_TEMP: dir, GITHUB_OUTPUT: output, ASKED: asked,
      PERMISSION: opts.permission ?? "none", HEAD_REPO: opts.headRepo ?? "owner/repo",
      REPO: "owner/repo", EVENT_NAME: opts.event, ACTOR: opts.actor, COMMENT: "/review", COMMENT_ON_PR: "https://api.github.com/repos/owner/repo/pulls/7",
      EVENT_NUMBER: "7", INPUT_NUMBER: "", COMMAND: "/review", MODE: "human", ALLOW_FORKS: opts.allowForks ?? "false", ALLOWED_BOTS: opts.bots ?? defaultBots,
    },
    encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return { run: readFileSync(output, "utf8").includes("run=true"), asked: readFileSync(asked, "utf8"), stdout: result.stdout };
}

test("the default allowed bot is claude[bot]", () => assert.equal(defaultBots, "claude[bot]"));

for (const event of ["issue_comment", "workflow_dispatch"]) {
  test(`an allowed bot starts a review from ${event} without write access`, t => {
    const result = ask(t, { event, actor: "claude[bot]" });
    assert.equal(result.run, true, result.stdout);
    assert.equal(result.asked, "");
  });

  test(`an actor without write access is still refused on ${event}`, t => {
    const result = ask(t, { event, actor: "someone" });
    assert.equal(result.run, false);
    assert.match(result.stdout, /someone does not have write access to owner\/repo/);
  });

  test(`a person with write access still starts a review on ${event}`, t => {
    assert.equal(ask(t, { event, actor: "maintainer", permission: "write" }).run, true);
  });
}

test("a bot that is not on the list still needs write access", t => {
  assert.equal(ask(t, { event: "issue_comment", actor: "other[bot]" }).run, false);
});

test("the list takes several bots and ignores spaces", t => {
  assert.equal(ask(t, { event: "issue_comment", actor: "other[bot]", bots: "claude[bot], other[bot]" }).run, true);
});

test("a name is matched whole, not as part of another", t => {
  assert.equal(ask(t, { event: "issue_comment", actor: "claude", bots: "claude[bot]" }).run, false);
  assert.equal(ask(t, { event: "issue_comment", actor: "x-claude[bot]", bots: "claude[bot]" }).run, false);
});

test("an empty list allows no bots", t => {
  assert.equal(ask(t, { event: "issue_comment", actor: "claude[bot]", bots: "" }).run, false);
});

test("an allowed bot does not get past the fork check", t => {
  const result = ask(t, { event: "issue_comment", actor: "claude[bot]", headRepo: "fork/repo" });
  assert.equal(result.run, false);
  assert.match(result.stdout, /comes from a fork/);
});
