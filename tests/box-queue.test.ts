import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

for (const preset of [undefined, "", "custom"] as const) {
  test(`the experiment queue preserves valid endpoint JSON with ${preset === "" ? "empty" : preset ?? "unset"} settings`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "rev-box-queue-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const path of ["scripts", "bin", "runs/smoke"]) mkdirSync(join(dir, path), { recursive: true });
    copyFileSync(new URL("../scripts/box-queue.sh", import.meta.url), join(dir, "scripts/box-queue.sh"));
    const executable = (path: string, body: string) => {
      writeFileSync(join(dir, path), body);
      chmodSync(join(dir, path), 0o755);
    };
    executable("bin/aws", '#!/bin/sh\nif [ "$3" = ssm ]; then echo synthetic; fi\n');
    executable("scripts/score.sh", "#!/bin/sh\nexit 0\n");
    executable("scripts/local-run.sh", `#!${process.execPath}
const {writeFileSync} = require('node:fs');
writeFileSync('runs/smoke/endpoint.json', JSON.stringify({
  body: process.env.RB_MODEL_EXTRA_BODY,
  byModel: process.env.RB_MODEL_EXTRA_BODY_BY_MODEL,
}));
`);
    writeFileSync(join(dir, "queue.txt"), "smoke 0 RB_CONFIG_MODEL=fixture\n");
    const custom = {
      RB_MODEL_EXTRA_BODY: '{ "provider": { "data_collection": "deny" } }',
      RB_MODEL_EXTRA_BODY_BY_MODEL: '{ "vendor/": { "reasoning": { "effort": "low" } } }',
    };
    const result = spawnSync("bash", [join(dir, "scripts/box-queue.sh"), join(dir, "queue.txt")], {
      env: {
        PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
        BOX_BUCKET: "fixture", BOX_REGION: "fixture", BOX_KEY_PARAMETER: "fixture",
        ...(preset === "custom" ? custom : preset === "" ? { RB_MODEL_EXTRA_BODY: "", RB_MODEL_EXTRA_BODY_BY_MODEL: "" } : {}),
      },
      encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const received = JSON.parse(readFileSync(join(dir, "runs/smoke/endpoint.json"), "utf8"));
    assert.deepEqual(JSON.parse(received.body), preset === "custom" ? JSON.parse(custom.RB_MODEL_EXTRA_BODY) : { usage: { include: true } });
    assert.deepEqual(JSON.parse(received.byModel), preset === "custom" ? JSON.parse(custom.RB_MODEL_EXTRA_BODY_BY_MODEL) : { "anthropic/": { cache_control: { type: "ephemeral" } } });
    if (preset === "custom") {
      assert.equal(received.body, custom.RB_MODEL_EXTRA_BODY);
      assert.equal(received.byModel, custom.RB_MODEL_EXTRA_BODY_BY_MODEL);
    }
  });
}
