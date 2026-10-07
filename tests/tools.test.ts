import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Workspace } from "../src/tools.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
}

function fixture(): { workspace: Workspace; root: string } {
  const root = mkdtempSync(join(tmpdir(), "rep-tools-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(root, "secret.txt"), "outside the checkout\n");
  writeFileSync(join(repo, "src", "a.ts"), "old one\nold two\n");
  git(repo, "init", "-q");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "src", "a.ts"), "line one\nline two NEEDLE\nline three\n");
  writeFileSync(join(repo, "src", "b.bin"), Buffer.from([0, 1, 2]));
  symlinkSync(join(root, "secret.txt"), join(repo, "leak.txt"));
  mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "dep", "index.js"), "NEEDLE\n");
  writeFileSync(join(root, "diff.patch"), "d1\nd2\nd3\n");
  return { workspace: new Workspace(repo, join(root, "diff.patch"), base), root };
}

async function call(workspace: Workspace, name: string, args: unknown): Promise<any> {
  return JSON.parse(await workspace.call(name, JSON.stringify(args)));
}

test("read_file returns numbered lines and the file length", async () => {
  const { workspace } = fixture();
  const result = await call(workspace, "read_file", { path: "src/a.ts", start_line: 2, line_count: 5 });
  assert.deepEqual(result, { ok: true, content: "2: line two NEEDLE\n3: line three", total_lines: 3 });
});

test("read_base_file returns the file as it was before the change", async () => {
  const { workspace } = fixture();
  const result = await call(workspace, "read_base_file", { path: "src/a.ts", start_line: 1, line_count: 10 });
  assert.equal(result.content, "1: old one\n2: old two");
  const missing = await call(workspace, "read_base_file", { path: "src/new.ts", start_line: 1, line_count: 10 });
  assert.deepEqual(missing, { ok: false, error: "file does not exist at the base revision" });
});

test("read_diff slices the diff", async () => {
  const { workspace } = fixture();
  assert.equal((await call(workspace, "read_diff", { start_line: 2, line_count: 1 })).content, "2: d2");
});

test("paths cannot leave the checkout", async () => {
  const { workspace } = fixture();
  const read = (path: string) => call(workspace, "read_file", { path, start_line: 1, line_count: 10 });
  assert.equal((await read("../secret.txt")).error, "parent path segments are not allowed");
  assert.equal((await read("/etc/passwd")).error, "path must be relative");
  assert.equal((await read("leak.txt")).error, "path escapes the checkout");
  assert.equal(await workspace.headFile("leak.txt"), null);
  assert.equal((await read("src/b.bin")).error, "binary files cannot be read");
  assert.equal((await read("src/nope.ts")).error, "path does not exist or cannot be read");
});

test("list_files and search skip symlinks, .git and node_modules", async () => {
  const { workspace } = fixture();
  assert.deepEqual((await call(workspace, "list_files", { path: "" })).files, ["src/a.ts", "src/b.bin"]);
  const found = await call(workspace, "search", { query: "needle", path: "", ignore_case: true });
  assert.deepEqual(found.results, [{ path: "src/a.ts", line: 2, text: "line two NEEDLE" }]);
  assert.deepEqual((await call(workspace, "search", { query: "needle", path: "", ignore_case: false })).results, []);
});

test("bad arguments and unknown tools return errors instead of throwing", async () => {
  const { workspace } = fixture();
  assert.equal(JSON.parse(await workspace.call("read_file", "{not json")).error, "arguments must be a JSON object");
  assert.equal((await call(workspace, "run_shell", { command: "id" })).error, "unknown tool");
});
