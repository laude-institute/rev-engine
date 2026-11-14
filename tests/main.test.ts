import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const main = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "main.ts");

/** A pull request checkout, and a claude on PATH that is installed but signed out. */
function signedOut(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "rev-main-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), `#!${process.execPath}
if (process.argv.includes("--version")) console.log("2.1.325 (Claude Code)");
else if (process.argv[2] === "auth") console.log(JSON.stringify({ loggedIn: false, authMethod: "none" }));
else process.exit(1);
`);
  chmodSync(join(bin, "claude"), 0o755);
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  writeFileSync(join(dir, "diff.patch"), ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1 +1,2 @@", " export const a = 1;", "+export const b = 2;", ""].join("\n"));
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: dir,
    RB_NWO: "owner/repo", RB_PR_NUMBER: "1", RB_BASE: "a".repeat(40), RB_HEAD: "b".repeat(40),
    RB_REPO: dir, RB_DIFF: join(dir, "diff.patch"), RB_PR_JSON: join(dir, "missing.json"), RB_OUT: join(dir, "out", "findings.json"),
    RB_CONFIG_ENGINE: "claude-code", RB_CONFIG_MODEL: "opus", RB_CONFIG_EFFORT: "xhigh",
    RB_CONFIG_VERIFY: "off", RB_CONFIG_SECOND_LOOK: "off", RB_CONFIG_RETRY_EMPTY: "off",
  };
  return { dir, env };
}

async function run(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [main], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const [code] = await once(child, "close");
  return { code, stderr };
}

test("a signed-out claude with no fallback is a setup error", async (t) => {
  const { env } = signedOut(t);
  const { code, stderr } = await run(env);
  assert.equal(code, 2);
  assert.match(stderr, /claude is not signed in/);
});

test("a signed-out claude with a fallback reviews every pass on the fallback model", async (t) => {
  const { env } = signedOut(t);
  const requests: Array<{ path: string; model: string; effort: unknown }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    requests.push({ path: request.url ?? "", model: parsed.model, effort: parsed.reasoning_effort });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "submit_review", arguments: JSON.stringify({ findings: [] }) } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;

  const { code, stderr } = await run({ ...env, RB_CONFIG_FALLBACK: "vendor/fallback", CMD_API_KEY: "synthetic", RB_FALLBACK_BASE_URL: `http://127.0.0.1:${port}/v1` });
  assert.equal(code, 0, stderr);
  assert.match(stderr, /claude is not signed in.*reviewing with the fallback vendor\/fallback at 127\.0\.0\.1/);
  assert.ok(requests.length > 0);
  for (const request of requests) {
    assert.equal(request.path, "/v1/chat/completions");
    assert.equal(request.model, "vendor/fallback");
    // Claude's effort levels are not sent to the chat endpoint.
    assert.equal(request.effort, undefined);
  }
  assert.deepEqual(JSON.parse(readFileSync(env.RB_OUT!, "utf8")).findings, []);
});
