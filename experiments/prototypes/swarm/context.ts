// More of the code a chunk touches, shown up front so an agent can check the chunk on its
// first call instead of reading files turn by turn: the code around each place a changed
// name is used, the definitions of what the chunk calls, the tests of the changed files,
// and the code as it was before the change. Turned on with RB_CONFIG_SWARM_CONTEXT=rich.
// Every part has a line limit, so a chunk's prompt stays a size a cheap model reads quickly.
import { execFile } from "node:child_process";
import { basename, extname } from "node:path";
import { promisify } from "node:util";
import { GENERATED } from "../../../src/review.ts";
import { chunkSymbols, DEFINITION, NOT_NAMES, numbered, type Chunk, type Mention } from "./chunks.ts";

const execFileAsync = promisify(execFile);

/** Lines shown above and below each place a changed name is used. */
const MENTION_RADIUS = 6;
const MAX_MENTION_LINES = 400;
/** The most called functions whose definitions a chunk is shown, and how much of each. */
const MAX_CALLEES = 10;
const DEFINITION_LINES = 30;
const MAX_DEFINITION_LINES = 400;
/** Lines shown around each line of a test file that mentions the change. */
const TEST_RADIUS = 8;
const MAX_TEST_LINES = 250;
const BASE_WINDOW = 30;
const MAX_BASE_LINES = 300;
const GREP_TIMEOUT_MS = 30_000;

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "typeof", "sizeof", "await", "new", "elif", "and", "not", "puts", "require", "raise", "assert", "lambda", "yield"]);

/** Names the chunk's added lines call, other than names the chunk itself defines. */
export function calledNames(chunk: Chunk): string[] {
  const own = new Set(chunkSymbols(chunk));
  const names: string[] = [];
  for (const unit of chunk.units) {
    for (const hunk of unit.hunks) {
      for (const line of hunk.text.split("\n").filter((text) => text.startsWith("+"))) {
        for (const match of line.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
          const name = match[1]!;
          if (name.length >= 3 && !own.has(name) && !NOT_NAMES.has(name) && !KEYWORDS.has(name) && !names.includes(name)) names.push(name);
        }
      }
    }
  }
  return names.slice(0, MAX_CALLEES);
}

/** Where each name is defined in the checkout, found with one git grep. A line counts when a definition pattern names it. */
export async function findDefinitions(repoDir: string, names: string[]): Promise<Map<string, Mention[]>> {
  const found = new Map<string, Mention[]>(names.map((name) => [name, []]));
  const safe = names.filter((name) => /^[A-Za-z_]\w*$/.test(name));
  if (!safe.length) return found;
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync(
      "git",
      ["-c", "safe.directory=*", "-C", repoDir, "grep", "-n", "-I", "-w", "-F", "--no-color", ...safe.flatMap((name) => ["-e", name]), "--", "."],
      { maxBuffer: 32_000_000, timeout: GREP_TIMEOUT_MS, env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" } },
    ));
  } catch (error) {
    stdout = (error as { stdout?: string }).stdout ?? "";
  }
  for (const row of stdout.split("\n")) {
    const match = /^(.+?):(\d+):(.*)$/.exec(row);
    if (!match || GENERATED.test(match[1]!)) continue;
    // The definition patterns are written for diff lines, so the line is given a leading "+".
    const line = `+${match[3]!}`;
    for (const pattern of DEFINITION) {
      for (const hit of line.matchAll(new RegExp(pattern.source, pattern.flags))) {
        const list = found.get(hit[1] ?? "");
        if (list && list.length < 2 && !list.some((known) => known.path === match[1] && known.line === Number(match[2]))) {
          list.push({ path: match[1]!, line: Number(match[2]), text: match[3]!.trim() });
        }
      }
    }
  }
  return found;
}

/** Test files that look like they test one of the changed files, by name. */
export function testFilesFor(paths: string[], allFiles: string[]): string[] {
  const stems = [...new Set(paths.map((path) => basename(path, extname(path)).toLowerCase()).filter((stem) => stem.length >= 3))];
  return allFiles.filter((file) => /(^|\/)(tests?|spec|__tests__)\/|[._-](test|spec)\.|(^|\/)test_/i.test(file)
    && !paths.includes(file)
    && stems.some((stem) => basename(file).toLowerCase().includes(stem))).slice(0, 6);
}

/** Numbered windows of a file around the given lines, with overlapping windows merged, up to a budget of lines. */
function windows(text: string, lines: number[], radius: number, budget: { left: number }): string[] {
  const total = text.split("\n").length;
  const ranges: Array<[number, number]> = [];
  for (const line of [...new Set(lines)].sort((a, b) => a - b)) {
    const from = Math.max(1, line - radius);
    const to = Math.min(total, line + radius);
    const last = ranges.at(-1);
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }
  const shown: string[] = [];
  for (const [from, to] of ranges) {
    if (budget.left <= 0) break;
    const end = Math.min(to, from + budget.left - 1);
    shown.push(numbered(text, from, end));
    budget.left -= end - from + 1;
  }
  return shown;
}

export interface RichSources {
  headFile: (path: string) => Promise<string | null>;
  baseFile: (path: string) => Promise<string | null>;
  mentions: Map<string, Mention[]>;
  definitions: Map<string, Mention[]>;
  allFiles: string[];
}

/** The extra context for one chunk, as prompt sections. Empty when there is nothing to add. */
export async function richContext(chunk: Chunk, sources: RichSources): Promise<string> {
  const parts: string[] = [];
  const inChunk = (mention: Mention): boolean => chunk.units.some((unit) =>
    unit.path === mention.path && unit.hunks.some((hunk) => mention.line >= hunk.start && mention.line <= hunk.end));
  const symbols = chunkSymbols(chunk);

  // The code around each use of a changed name, grouped by file.
  const byFile = new Map<string, number[]>();
  for (const name of symbols) {
    for (const mention of sources.mentions.get(name) ?? []) {
      if (!inChunk(mention)) byFile.set(mention.path, [...(byFile.get(mention.path) ?? []), mention.line]);
    }
  }
  const mentionBudget = { left: MAX_MENTION_LINES };
  const mentionParts: string[] = [];
  for (const [path, lines] of byFile) {
    const text = await sources.headFile(path);
    if (text === null || mentionBudget.left <= 0) continue;
    mentionParts.push(`<code path="${path}">\n${windows(text, lines, MENTION_RADIUS, mentionBudget).join("\n...\n")}\n</code>`);
  }
  if (mentionParts.length) parts.push(`The code around each place a name this chunk changes is used, after the change:\n\n${mentionParts.join("\n\n")}`);

  // The definitions of what the chunk calls.
  const definitionBudget = { left: MAX_DEFINITION_LINES };
  const definitionParts: string[] = [];
  for (const name of calledNames(chunk)) {
    for (const definition of sources.definitions.get(name) ?? []) {
      const text = await sources.headFile(definition.path);
      if (text === null || definitionBudget.left <= 0) continue;
      const end = Math.min(definition.line + DEFINITION_LINES - 1, definition.line + definitionBudget.left - 1);
      definitionParts.push(`<definition name="${name}" path="${definition.path}">\n${numbered(text, definition.line, end)}\n</definition>`);
      definitionBudget.left -= end - definition.line + 1;
    }
  }
  if (definitionParts.length) parts.push(`The definitions of functions this chunk calls, after the change, the first ${DEFINITION_LINES} lines of each:\n\n${definitionParts.join("\n\n")}`);

  // The tests of the changed files, around the lines that mention the change.
  const paths = [...new Set(chunk.units.map((unit) => unit.path))];
  const words = [...symbols, ...paths.map((path) => basename(path, extname(path)))].filter((word) => word.length >= 3);
  const testBudget = { left: MAX_TEST_LINES };
  const testParts: string[] = [];
  for (const file of testFilesFor(paths, sources.allFiles)) {
    const text = await sources.headFile(file);
    if (text === null || testBudget.left <= 0) continue;
    const lines = text.split("\n").flatMap((line, index) => words.some((word) => line.includes(word)) ? [index + 1] : []);
    if (lines.length) testParts.push(`<test path="${file}">\n${windows(text, lines, TEST_RADIUS, testBudget).join("\n...\n")}\n</test>`);
  }
  if (testParts.length) parts.push(`Tests that look like they cover the changed files, around the lines that mention them:\n\n${testParts.join("\n\n")}`);

  // The code as it was before the change.
  const baseBudget = { left: MAX_BASE_LINES };
  const baseParts: string[] = [];
  for (const unit of chunk.units) {
    const text = await sources.baseFile(unit.path);
    const oldStarts = unit.hunks.map((hunk) => Number(/^@@ -(\d+)/.exec(hunk.text)?.[1])).filter((line) => line > 0);
    if (text === null || !oldStarts.length || baseBudget.left <= 0) continue;
    baseParts.push(`<before path="${unit.path}">\n${windows(text, oldStarts, BASE_WINDOW, baseBudget).join("\n...\n")}\n</before>`);
  }
  if (baseParts.length) parts.push(`The same places before the change, at the base revision:\n\n${baseParts.join("\n\n")}`);
  return parts.join("\n\n");
}
