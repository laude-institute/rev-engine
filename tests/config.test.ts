import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BASE_URL, DEFAULT_MODEL, describeSettings, loadConfig } from "../src/config.ts";

const BASE = {
  RB_NWO: "owner/repo",
  RB_PR_NUMBER: "1938",
  RB_BASE: "a".repeat(40),
  RB_HEAD: "b".repeat(40),
  RB_OUT: "/work/out/findings.json",
  OPENROUTER_API_KEY: "test-key",
};

test("applies defaults when only the contract variables are set", () => {
  const config = loadConfig(BASE);
  assert.equal(config.prNumber, 1938);
  assert.equal(config.agent, "rev-engine-prime");
  assert.equal(config.repoDir, "/work/repo");
  assert.equal(config.baseUrl, DEFAULT_BASE_URL);
  assert.deepEqual(config.models, [DEFAULT_MODEL]);
  assert.equal(config.verifierModel, DEFAULT_MODEL);
  assert.equal(config.verify, "lenient");
  assert.equal(config.budgetMs, 780_000);
});

test("reads the reviewer settings from RB_CONFIG variables", () => {
  const config = loadConfig({
    ...BASE,
    RB_AGENT: "registered-name",
    RB_MODEL_BASE_URL: "https://example.com/v1/",
    RB_CONFIG_MODEL: "vendor/one, vendor/two",
    RB_CONFIG_VERIFIER: "vendor/three",
    RB_CONFIG_VERIFY: "strict",
    RB_CONFIG_EFFORT: "high",
    RB_CONFIG_MAX_FINDINGS: "10",
    RB_CONFIG_TIME_BUDGET: "600",
  });
  assert.equal(config.agent, "registered-name");
  assert.equal(config.baseUrl, "https://example.com/v1");
  assert.deepEqual(config.models, ["vendor/one", "vendor/two"]);
  assert.equal(config.verifierModel, "vendor/three");
  const settings = describeSettings(config);
  for (const value of ["vendor/one,vendor/two", "vendor/three", "strict", "high", "10", "600"]) assert.ok(settings.includes(value), value);
  assert.ok(!settings.includes("test-key"));
});

test("rejects missing or malformed inputs", () => {
  assert.throws(() => loadConfig({ ...BASE, RB_HEAD: "abc123" }), /RB_HEAD is not a 40-character commit SHA/);
  assert.throws(() => loadConfig({ ...BASE, OPENROUTER_API_KEY: "" }), /missing OPENROUTER_API_KEY/);
  assert.throws(() => loadConfig({ ...BASE, RB_PR_NUMBER: "abc" }), /RB_PR_NUMBER/);
  assert.throws(() => loadConfig({ ...BASE, RB_CONFIG_VERIFY: "maybe" }), /RB_CONFIG_VERIFY/);
  assert.throws(() => loadConfig({ ...BASE, RB_CONFIG_MAX_FINDINGS: "0" }), /RB_CONFIG_MAX_FINDINGS/);
});
