import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { endpointOf, mergeBodies, readEnvFile } from "../src/endpoint.ts";
import { routingBody } from "../experiments/prototypes/swarm/review.ts";

test("an env file gives its NAME=value lines, unquoted, and a missing file gives none", () => {
  const dir = mkdtempSync(join(tmpdir(), "rev-env-"));
  const path = join(dir, ".env");
  writeFileSync(path, [
    "# a comment",
    "RB_MODEL_BASE_URL=https://example.test/v1 # endpoint",
    "export MODEL_API_KEY=\"quoted key\" # credential",
    "RB_MODEL_EXTRA_BODY='{\"usage\":{\"include\":true}}' # cost",
    "not a line",
  ].join("\n"));
  const env = readEnvFile(path);
  assert.deepEqual(env, { RB_MODEL_BASE_URL: "https://example.test/v1", MODEL_API_KEY: "quoted key", RB_MODEL_EXTRA_BODY: '{"usage":{"include":true}}' });
  assert.deepEqual(endpointOf(env, "MODEL").extraBody, { usage: { include: true } });
  // The scripts lay the shell over the file, so the shell wins.
  assert.equal(endpointOf({ ...env, MODEL_API_KEY: "from the shell" }, "MODEL").apiKey, "from the shell");
  assert.deepEqual(readEnvFile(join(dir, "missing")), {});
});

test("a model's own extra fields are read by model name prefix", () => {
  const base = { RB_MODEL_BASE_URL: "https://example.test/v1", MODEL_API_KEY: "k" };
  assert.deepEqual(endpointOf({ ...base, RB_MODEL_EXTRA_BODY_BY_MODEL: '{"anthropic/":{"cache_control":{"type":"ephemeral"}}}' }, "MODEL").extraBodyByModel,
    { "anthropic/": { cache_control: { type: "ephemeral" } } });
  assert.throws(() => endpointOf({ ...base, RB_MODEL_EXTRA_BODY_BY_MODEL: '{"anthropic/":true}' }, "MODEL"), /must map each model name prefix to a JSON object/);
});

test("extra fields are merged one level deep, later sets winning", () => {
  assert.deepEqual(mergeBodies({ provider: { a: 1 }, usage: { include: true } }, undefined, { provider: { b: 2 }, usage: "replaced" }),
    { provider: { a: 1, b: 2 }, usage: "replaced" });
});

test("the swarm builds its OpenRouter routing and reasoning budget fields", () => {
  assert.deepEqual(routingBody({ sort: null, providers: [], reasoningTokens: null }), {});
  assert.deepEqual(routingBody({ sort: "latency", providers: ["together"], reasoningTokens: 1500 }), {
    provider: { sort: "latency", only: ["together"], allow_fallbacks: false },
    reasoning: { max_tokens: 1500 },
  });
});

for (const prefix of ["MODEL", "FALLBACK"] as const) {
  test(`${prefix} endpoints require HTTPS except for loopback and never log embedded credentials`, () => {
    const env = { [`${prefix}_API_KEY`]: "synthetic" };
    const endpoint = (url: string) => endpointOf({ ...env, [`RB_${prefix}_BASE_URL`]: url }, prefix);
    for (const url of ["http://example.test/v1", "http://192.168.1.2/v1", "http://localhost.example.test/v1", "http://127.0.0.1.example.test/v1"]) {
      assert.throws(() => endpoint(url), /must use HTTPS/, url);
    }
    for (const url of ["https://example.test/v1", "http://localhost:8123/v1", "http://127.0.0.1:8123/v1", "http://[::1]:8123/v1"]) {
      assert.equal(endpoint(url).baseUrl, url);
    }
    for (const url of ["https://user:synthetic-secret@example.test/v1", "https://example.test/v1?key=synthetic-secret", "https://example.test/v1#synthetic-secret", "synthetic-secret"]) {
      assert.throws(() => endpoint(url), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes("synthetic-secret"));
        return true;
      });
    }
  });
}

test("the legacy OpenRouter key cannot be used with a different endpoint", () => {
  const env = { OPENROUTER_API_KEY: "synthetic-router" };
  for (const url of ["https://example.test/v1", "https://openrouter.ai.example.test/api/v1", "https://openrouter.ai:8443/api/v1", "https://openrouter.ai/other", "http://localhost:8123/v1"]) {
    assert.throws(() => endpointOf({ ...env, RB_MODEL_BASE_URL: url }, "MODEL"), /OPENROUTER_API_KEY requires the standard OpenRouter endpoint/, url);
  }
  for (const url of ["https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1/"]) {
    assert.equal(endpointOf({ ...env, RB_MODEL_BASE_URL: url }, "MODEL").apiKey, env.OPENROUTER_API_KEY);
  }
  assert.equal(endpointOf({ ...env, MODEL_API_KEY: "synthetic-other", RB_MODEL_BASE_URL: "https://example.test/v1" }, "MODEL").apiKey, "synthetic-other");
  assert.throws(() => endpointOf({ ...env, RB_FALLBACK_BASE_URL: "https://openrouter.ai/api/v1" }, "FALLBACK"), /missing FALLBACK_API_KEY/);
});
