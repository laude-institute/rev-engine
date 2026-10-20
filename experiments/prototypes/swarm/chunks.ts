// Splits a diff into chunks, one agent's share of the change each, and gathers the
// context a chunk's agents start with, so a cheap model spends few turns finding it.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GENERATED } from "../../../src/review.ts";

const execFileAsync = promisify(execFile);

/** Hunks of one file closer than this many lines are reviewed as one unit. */
const UNIT_GAP = 20;
/** The smallest chunk worth its own agents, in changed diff lines. */
const MIN_CHUNK_LINES = 120;
/** Lines of the file shown above and below each unit. */
const WINDOW_LINES = 30;
const MAX_WINDOW_LINES = 300;
const MAX_SYMBOLS_PER_CHUNK = 8;
const MAX_MENTIONS_PER_SYMBOL = 15;
/** A search that takes longer than this on a huge checkout is given up; the agents can search themselves. */
const GREP_TIMEOUT_MS = 30_000;

export interface Hunk {
  /** First and last line at head that the hunk covers, context included. */
  start: number;
  end: number;
  /** The hunk as it appears in the diff, header included. */
  text: string;
  /** Added and removed lines. */
  size: number;
}

export interface FileDiff {
  path: string;
  hunks: Hunk[];
}

/** One unit of review: the hunks of one file that sit close together. */
export interface Unit {
  path: string;
  hunks: Hunk[];
  size: number;
}

export interface Chunk {
  id: string;
  units: Unit[];
}

/** The files a diff changes at head, each with its hunks. Deleted files are left out, because nothing in them can be cited. */
export function splitDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  let hunk: { start: number; lines: string[]; size: number; headLines: number } | null = null;
  let inHeader = false;
  const closeHunk = (): void => {
    if (file && hunk) {
      file.hunks.push({ start: hunk.start, end: hunk.start + Math.max(hunk.headLines, 1) - 1, text: hunk.lines.join("\n"), size: hunk.size });
    }
    hunk = null;
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      closeHunk();
      file = null;
      inHeader = true;
      continue;
    }
    if (inHeader && line.startsWith("+++ ")) {
      const path = line.slice(4).trim().replace(/^"|"$/g, "");
      if (path !== "/dev/null") {
        file = { path: path.replace(/^b\//, ""), hunks: [] };
        files.push(file);
      }
      continue;
    }
    const header = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      closeHunk();
      inHeader = false;
      if (file) hunk = { start: Number(header[1]), lines: [line], size: 0, headLines: 0 };
      continue;
    }
    if (inHeader || !hunk) continue;
    const current: { lines: string[]; size: number; headLines: number } = hunk;
    current.lines.push(line);
    if (line.startsWith("+")) {
      current.size += 1;
      current.headLines += 1;
    } else if (line.startsWith("-")) {
      current.size += 1;
    } else if (line.startsWith(" ")) {
      current.headLines += 1;
    }
  }
  closeHunk();
  return files.filter((entry) => entry.hunks.length);
}

/** Groups each file's nearby hunks into units, skipping generated files. */
export function units(files: FileDiff[]): Unit[] {
  const result: Unit[] = [];
  for (const file of files) {
    if (GENERATED.test(file.path)) continue;
    let unit: Unit | null = null;
    for (const hunk of file.hunks) {
      const last: Hunk | undefined = unit?.hunks.at(-1);
      if (unit && last && hunk.start - last.end <= UNIT_GAP) {
        unit.hunks.push(hunk);
        unit.size += hunk.size;
      } else {
        unit = { path: file.path, hunks: [hunk], size: hunk.size };
        result.push(unit);
      }
    }
  }
  return result;
}

/**
 * Packs units into at most `max` chunks, in diff order. A chunk takes units until it
 * reaches its share of the change, so a large change gets larger chunks, not more of them.
 */
export function chunk(all: Unit[], max: number): Chunk[] {
  const total = all.reduce((sum, unit) => sum + unit.size, 0);
  const target = Math.max(MIN_CHUNK_LINES, Math.ceil(total / max));
  const chunks: Chunk[] = [];
  let size = 0;
  for (const unit of all) {
    if (!chunks.length || size >= target) {
      chunks.push({ id: `c${chunks.length + 1}`, units: [] });
      size = 0;
    }
    chunks.at(-1)!.units.push(unit);
    size += unit.size;
  }
  return chunks;
}

const DEFINITION = [
  /\b(?:function|def|func|fn|class|interface|struct|enum|trait|module|record|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/g,
  /\b(?:const|let|var|val)\s+([A-Za-z_][\w]*)\s*(?::[^=]+)?=/g,
  /^[+-]\s*(?:(?:export|public|private|protected|internal|static|async|override|abstract|final|virtual|readonly)\s+)*(?:[\w<>[\],.?]+\s+)?([A-Za-z_][\w]*)\s*\([^)]*\)\s*(?::\s*[^{=]+)?\s*(?:\{|=>|throws\b)/gm,
  /^[+-]\s*([A-Z][A-Z0-9_]{3,})\s*[:=]/gm,
];

const NOT_NAMES = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "new", "else", "await", "async", "typeof", "sizeof",
  "print", "self", "this", "super", "true", "false", "null", "None", "True", "False", "main", "init", "constructor",
  "get", "set", "test", "describe", "expect", "assert", "with", "from", "import", "export", "default", "public",
  "private", "static", "void", "string", "number", "boolean", "int", "float", "bool", "str", "len", "err", "error",
]);

/** Names the chunk defines, redefines or removes, which other code may use. */
export function chunkSymbols(chunk: Chunk): string[] {
  const names: string[] = [];
  for (const unit of chunk.units) {
    for (const hunk of unit.hunks) {
      const changed = hunk.text.split("\n").filter((line) => /^[+-]/.test(line)).join("\n");
      for (const pattern of DEFINITION) {
        for (const match of changed.matchAll(pattern)) {
          const name = match[1];
          if (name && name.length >= 3 && !NOT_NAMES.has(name) && !names.includes(name)) names.push(name);
        }
      }
    }
  }
  return names.slice(0, MAX_SYMBOLS_PER_CHUNK);
}

export interface Mention {
  path: string;
  line: number;
  text: string;
}

/**
 * Every line in the checkout that mentions one of the names, as a whole word, found
 * with one git grep. Names are plain identifiers, so they are safe to pass as arguments.
 */
export async function findMentions(repoDir: string, names: string[]): Promise<Map<string, Mention[]>> {
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
    // git grep exits with 1 when nothing matches. A timeout or other failure keeps what was found
    // so far; a last line cut short only shortens the text shown for that mention.
    stdout = (error as { stdout?: string }).stdout ?? "";
  }
  const words = new Map(safe.map((name) => [name, new RegExp(`(^|[^\\w])${name}([^\\w]|$)`)]));
  for (const row of stdout.split("\n")) {
    const match = /^(.+?):(\d+):(.*)$/.exec(row);
    if (!match || GENERATED.test(match[1]!)) continue;
    for (const [name, word] of words) {
      const list = found.get(name)!;
      if (list.length < MAX_MENTIONS_PER_SYMBOL && word.test(match[3]!)) {
        list.push({ path: match[1]!, line: Number(match[2]), text: match[3]!.trim().slice(0, 200) });
      }
    }
  }
  return found;
}

function numbered(text: string, first: number, last: number): string {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(first - 1, last).map((line, index) => `${first + index}: ${line}`).join("\n");
}

/** What a chunk's agents see: its hunks, the file around each unit, and where its names are used. */
export async function chunkContext(chunk: Chunk, headFile: (path: string) => Promise<string | null>, mentions: Map<string, Mention[]>): Promise<string> {
  const parts: string[] = [];
  for (const unit of chunk.units) {
    const first = Math.max(1, unit.hunks[0]!.start - WINDOW_LINES);
    const last = Math.min(first + MAX_WINDOW_LINES - 1, unit.hunks.at(-1)!.end + WINDOW_LINES);
    const text = await headFile(unit.path);
    const window = text === null ? "(the file cannot be shown; read it with read_file)" : numbered(text, first, last);
    parts.push(`<chunk_diff path="${unit.path}">\n${unit.hunks.map((hunk) => hunk.text).join("\n")}\n</chunk_diff>\n\n<file_after_change path="${unit.path}" lines="${first}-${last}">\n${window}\n</file_after_change>`);
  }
  const inChunk = (mention: Mention): boolean => chunk.units.some((unit) =>
    unit.path === mention.path && unit.hunks.some((hunk) => mention.line >= hunk.start && mention.line <= hunk.end));
  const listed = chunkSymbols(chunk).map((name) => {
    const others = (mentions.get(name) ?? []).filter((mention) => !inChunk(mention));
    const rows = others.map((mention) => `  ${mention.path}:${mention.line}: ${mention.text}`).join("\n");
    return `- ${name}\n${rows || "  (no other mentions found)"}`;
  });
  if (listed.length) parts.push(`Mentions of names this chunk touches, found by a whole-word search of the checkout after the change. Lists stop at ${MAX_MENTIONS_PER_SYMBOL} mentions; search for more when you need them.\n${listed.join("\n")}`);
  return parts.join("\n\n");
}

/** A short description of a chunk for the log and the prompt, such as "src/a.ts lines 10 to 40". */
export function describeChunk(chunk: Chunk): string {
  return chunk.units.map((unit) => `${unit.path} lines ${unit.hunks[0]!.start} to ${unit.hunks.at(-1)!.end}`).join(", ");
}
