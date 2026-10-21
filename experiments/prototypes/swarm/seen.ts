// Works out which lines of which files an agent had in its prompt, from the prompt text the
// transcript keeps. The analysis of misses needs it: with rich context an agent is shown call
// sites, definitions and tests far from its chunk, which it never has to read with a tool.

/** Line ranges after the change, by path, and which kind of block showed each one. */
export type Seen = Map<string, Array<{ from: number; to: number; source: string }>>;

/** Blocks whose lines are numbered as the file stands after the change. */
const NUMBERED = ["file_after_change", "code", "definition", "test", "uses"];

function add(seen: Seen, path: string, from: number, to: number, source: string): void {
  if (to < from) return;
  seen.set(path, [...(seen.get(path) ?? []), { from, to, source }]);
}

/** The new-file lines each hunk header of a diff covers, under the path it belongs to. */
function diffLines(seen: Seen, text: string, source: string, path: string | null): void {
  let current = path;
  for (const line of text.split("\n")) {
    const file = line.match(/^\+\+\+ b\/(.+)$/);
    if (file) { current = file[1]!; continue; }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk && current) {
      const start = Number(hunk[1]);
      add(seen, current, start, start + (hunk[2] === undefined ? 1 : Number(hunk[2])) - 1, source);
    }
  }
}

/**
 * Reads a prompt's tagged blocks. Numbered blocks give their numbered lines, diffs give the
 * lines their hunks cover, and a mention list gives each "path:line:" it names. A block of
 * the file before the change is left out, because its line numbers are not the file's now.
 */
export function promptLines(prompt: string): Seen {
  const seen: Seen = new Map();
  const blocks = /<([a-z_]+)((?: [a-z_]+="[^"]*")*)>\n([\s\S]*?)\n<\/\1>/g;
  for (const [, tag, attributes, body] of prompt.matchAll(blocks)) {
    const path = attributes!.match(/ path="([^"]*)"/)?.[1] ?? null;
    if (tag === "diff" || tag === "chunk_diff") diffLines(seen, body!, tag, path);
    else if (path && NUMBERED.includes(tag!)) {
      const numbers = [...body!.matchAll(/^(\d+): /gm)].map((match) => Number(match[1]));
      // Consecutive numbers form one range; a "..." between windows starts another.
      let start: number | null = null;
      let last = 0;
      for (const number of numbers) {
        if (start !== null && number !== last + 1) { add(seen, path, start, last, tag!); start = null; }
        if (start === null) start = number;
        last = number;
      }
      if (start !== null) add(seen, path, start, last, tag!);
    }
  }
  for (const [, path, line] of prompt.matchAll(/^ {2}(\S+):(\d+): /gm)) add(seen, path!, Number(line), Number(line), "mention");
  return seen;
}

/** The kinds of block that showed any of the lines from `from` to `to` of `path`. */
export function sawLines(seen: Seen, path: string, from: number, to: number): string[] {
  return [...new Set((seen.get(path) ?? []).filter((range) => range.from <= to && range.to >= from).map((range) => range.source))];
}
