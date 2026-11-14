import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("the image accepts exact Claude Code versions and rejects ranges before npm runs", () => {
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  const install = dockerfile.match(/RUN if \[ -n "\$CLAUDE_CODE_VERSION" \]; then[\s\S]*?\n    fi/)![0].slice(4).replace(/\\\n/g, " ");
  const dir = mkdtempSync(join(tmpdir(), "rev-pin-"));
  try {
    writeFileSync(join(dir, "npm"), '#!/bin/sh\nprintf "%s\\n" "$*"\n', { mode: 0o755 });
    const run = (version: string) => execFileSync("sh", ["-c", install], { env: { PATH: `${dir}:${process.env.PATH}`, CLAUDE_CODE_VERSION: version }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(run(""), "");
    assert.match(run("2.1.321"), /install -g @anthropic-ai\/claude-code@2\.1\.321/);
    for (const version of ["latest", "2.1.321 || 2.1.322", "2.1.321 - 3.0.0", "2.1.3x", "2.1", "2.1.321\n|| 3.0.0"]) {
      assert.throws(() => run(version), /CLAUDE_CODE_VERSION/, version);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
