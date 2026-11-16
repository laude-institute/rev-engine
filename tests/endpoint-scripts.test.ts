import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "rev-endpoint-scripts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "bin"));
  const executable = (name: string, body: string) => {
    const path = join(dir, "bin", name);
    writeFileSync(path, `#!${process.execPath}\n${body}`);
    chmodSync(path, 0o755);
  };
  const env = { PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`, OBSERVED: join(dir, "observed.json") };
  return { dir, env, executable };
}

for (const [api, legacy, endpoint, rejected] of [["chat", false, "https://models.example.test/v1", false], ["responses", false, "https://models.example.test/v1", false], ["chat", true, "", false], ["chat", true, "https://models.example.test/v1", true]] as const) test(`the action forwards ${api}, legacy ${legacy}, endpoint ${endpoint}`, t => {
  const f = fixture(t);
  const action = readFileSync(new URL("../action.yml", import.meta.url), "utf8");
  const step = action.split("    - name: Review\n")[1]!.split("    # Keep the findings")[0]!;
  const script = step.split("      run: |\n")[1]!.split("\n").map(line => line.replace(/^        /, "")).join("\n");
  const inputs: Record<string, string> = { "model-api": api, "model-base-url": endpoint, "model-extra-body": "", "model-extra-body-by-model": "", "agent-providers": "", "agent-model": "fixture/model", model: "fixture/model", "time-budget": "60" };
  const mapped = Object.fromEntries([...step.matchAll(/^        ([A-Z_]+): \$\{\{ inputs\.([\w-]+) \}\}$/gm)].map(match => [match[1]!, inputs[match[2]!] ?? ""]));
  f.executable("docker", `
const forwarded = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) if (args[i] === '-e') {
  const [key, ...value] = args[++i].split('=');
  forwarded[key] = value.length ? value.join('=') : process.env[key];
}
require('node:fs').writeFileSync(process.env.OBSERVED, JSON.stringify(forwarded));
`);
  const scriptPath = join(f.dir, "review.sh");
  writeFileSync(scriptPath, script);
  const result = spawnSync("bash", [scriptPath], {
    env: { ...f.env, ...mapped, MODEL_API_KEY: "synthetic", LEGACY_KEY: String(legacy), MODE: "agent", GITHUB_WORKSPACE: f.dir, RUNNER_TEMP: f.dir }, encoding: "utf8", timeout: 10_000,
  });
  if (rejected) {
    assert.equal(result.status, 1, result.stderr);
    assert.equal(existsSync(f.env.OBSERVED), false);
    return;
  }
  assert.equal(result.status, 0, result.stderr);
  const forwarded = JSON.parse(readFileSync(f.env.OBSERVED, "utf8"));
  assert.equal(forwarded.RB_MODEL_API, api);
  assert.equal(forwarded.RB_MODEL_BASE_URL, legacy ? "https://openrouter.ai/api/v1" : endpoint);
  if (legacy) {
    assert.deepEqual(JSON.parse(forwarded.RB_MODEL_EXTRA_BODY), { usage: { include: true } });
    assert.deepEqual(JSON.parse(forwarded.RB_MODEL_EXTRA_BODY_BY_MODEL), { "anthropic/": { cache_control: { type: "ephemeral" } } });
  }
  assert.equal(forwarded.RB_CONFIG_SWARM_PROVIDERS, "");
});

for (const [name, endpoint, explicitKey, expected] of [
  ["OpenRouter endpoint", "https://openrouter.ai/api/v1", "", "synthetic-model"],
  ["OpenRouter endpoint with trailing slash", "https://openrouter.ai/api/v1/", "", "synthetic-model"],
  ["another endpoint", "https://models.example.test/v1", "", null],
  ["lookalike host", "https://openrouter.ai.example.test/api/v1", "", null],
  ["missing endpoint", "", "", null],
  ["explicit judge key", "https://models.example.test/v1", "synthetic-judge", "synthetic-judge"],
] as const) test(`the scorer chooses credentials safely with ${name}`, t => {
  const f = fixture(t);
  for (const path of ["scripts", "bench/node_modules", "runs/smoke/findings"]) mkdirSync(join(f.dir, path), { recursive: true });
  copyFileSync(new URL("../scripts/score.sh", import.meta.url), join(f.dir, "scripts/score.sh"));
  f.executable("npx", `require('node:fs').writeFileSync(process.env.OBSERVED, JSON.stringify({key:process.env.OPENROUTER_API_KEY})); console.log('openrouter fixture/model');`);
  f.executable("jq", "");
  f.executable("npm", "");
  const result = spawnSync("bash", [join(f.dir, "scripts/score.sh"), "smoke"], {
    env: { ...f.env, REVIEWBENCH_DIR: join(f.dir, "bench"), JUDGE_MODEL: "fixture/model", MODEL_API_KEY: "synthetic-model", RB_MODEL_BASE_URL: endpoint, OPENROUTER_API_KEY: explicitKey },
    encoding: "utf8", timeout: 10_000,
  });
  if (expected === null) {
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Set OPENROUTER_API_KEY/);
    assert.equal(existsSync(f.env.OBSERVED), false);
  } else {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(f.env.OBSERVED, "utf8")).key, expected);
  }
});


test("box creation refuses another endpoint's key before storing credentials", t => {
  const f = fixture(t);
  mkdirSync(join(f.dir, "scripts"));
  copyFileSync(new URL("../scripts/box.sh", import.meta.url), join(f.dir, "scripts/box.sh"));
  f.executable("aws", `if (process.argv.includes('sts')) console.log('fixture-account'); else { require('node:fs').writeFileSync(process.env.OBSERVED, 'unexpected mutation'); process.exit(7); }`);
  const result = spawnSync("bash", [join(f.dir, "scripts/box.sh"), "up"], {
    env: { ...f.env, MODEL_API_KEY: "synthetic-other", RB_MODEL_BASE_URL: "https://models.example.test/v1" }, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Set OPENROUTER_API_KEY/);
  assert.equal(existsSync(f.env.OBSERVED), false);
});
