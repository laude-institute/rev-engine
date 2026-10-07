import assert from "node:assert/strict";
import { test } from "node:test";
import { pickDesignDocs } from "../src/docs.ts";

test("offers documents beside the changed code, design directories and root documents", () => {
  const files = [
    "AGENTS.md",
    "README.md",
    "ARCHITECTURE.md",
    "LICENSE",
    ".github/CODEOWNERS",
    "docs/design/storage.md",
    "docs/adr/0001-queue.md",
    "docs/guide/install.md",
    "packages/api/README.md",
    "packages/api/src/AGENTS.md",
    "packages/web/README.md",
    "packages/api/src/handler.ts",
    "a/b/c/d/e/design/deep.md",
  ];
  assert.deepEqual(pickDesignDocs(files, ["packages/api/src/handler.ts"], ["AGENTS.md"]), [
    "packages/api/src/AGENTS.md",
    "packages/api/README.md",
    "docs/design/storage.md",
    "docs/adr/0001-queue.md",
    "README.md",
    "ARCHITECTURE.md",
    ".github/CODEOWNERS",
  ]);
});

test("returns nothing for a repository with no documents", () => {
  assert.deepEqual(pickDesignDocs(["src/a.ts", "src/b.ts"], ["src/a.ts"], []), []);
});
