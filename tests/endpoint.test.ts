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
    "RB_MODEL_BASE_URL=https://example.test/v1",
    "export MODEL_API_KEY=\"quoted key\"",
    "RB_MODEL_EXTRA_BODY='{\"usage\":{\"include\":true}}'",
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
