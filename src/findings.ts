// Turns what the models submit into the findings file: checks every path and
// line against the checkout, merges duplicates, applies verification verdicts
// and caps the list.

export type Severity = "high" | "medium" | "low";

export interface Candidate {
  id: string;
  seat: string;
  file: string;
  startLine: number;
  endLine: number;
  severity: Severity;
  title: string;
  detail: string;
  confidence: number;
}

export interface OutputFinding {
  file: string;
  start_line: number;
  end_line: number;
  message: string;
  producer: string;
}

export interface Verdict {
  id: string;
  verdict: "confirmed" | "rejected" | "uncertain";
  duplicateOf: string | null;
}

/** Line ranges the change added or modified, per file, numbered as at head. */
export type ChangedLines = Map<string, Array<[number, number]>>;

const MAX_MESSAGE_CHARS = 2_500;
const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export function parseDiff(diff: string): ChangedLines {
  const changed: ChangedLines = new Map();
  let ranges: Array<[number, number]> | null = null;
  let line = 0;
  let runStart: number | null = null;
  const closeRun = () => {
    if (ranges && runStart !== null) ranges.push([runStart, line - 1]);
    runStart = null;
  };
  // File headers sit between "diff --git" and the first hunk. Inside a hunk, a
  // line starting with "+++ " is an added line, not a header.
  let inHeader = false;
  for (const text of diff.split("\n")) {
    if (text.startsWith("diff --git ")) {
      closeRun();
      ranges = null;
      inHeader = true;
      continue;
    }
    if (inHeader && text.startsWith("+++ ")) {
      const path = text.slice(4).trim().replace(/^"|"$/g, "");
      if (path !== "/dev/null") {
        ranges = [];
        changed.set(path.replace(/^b\//, ""), ranges);
      }
      continue;
    }
    const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      closeRun();
      inHeader = false;
      line = Number(hunk[1]);
      continue;
    }
    if (inHeader || !ranges) continue;
    if (text.startsWith("+")) {
      runStart ??= line;
      line += 1;
    } else if (text.startsWith(" ")) {
      closeRun();
      line += 1;
    } else {
      closeRun(); // a removed line, or a "\ No newline" marker; neither exists at head
    }
  }
  closeRun();
  return changed;
}

export function countLines(text: string): number {
  if (!text) return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

function text(value: unknown, max: number): string {
  return (typeof value === "string" ? value : "").replace(/\s+/g, " ").trim().slice(0, max);
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export interface NormalizeContext {
  seat: string;
  repoDir: string;
  changed: ChangedLines;
  /** The text of a file at head, or null when it cannot be cited. */
  headFile: (path: string) => Promise<string | null>;
  log: (message: string) => void;
}

/** Models sometimes cite absolute paths or the diff's a/ and b/ prefixes. Returns the spellings worth trying. */
function pathSpellings(raw: string, repoDir: string): string[] {
  let path = raw.trim().replaceAll("\\", "/");
  const prefix = `${repoDir.replace(/\/+$/, "")}/`;
  if (path.startsWith(prefix)) path = path.slice(prefix.length);
  path = path.replace(/^(\.\/)+/, "").replace(/^\/+/, "");
  const spellings = [path];
  if (/^[ab]\//.test(path)) spellings.push(path.slice(2));
  return spellings.filter((spelling) => spelling && !spelling.split("/").includes(".."));
}

export async function normalizeCandidates(raw: unknown, context: NormalizeContext): Promise<Candidate[]> {
  if (!Array.isArray(raw)) return [];
  const candidates: Candidate[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const title = text(item.title, 300);
    const detail = text(item.detail, 4_000);
    if (!title && !detail) continue;

    let file: string | null = null;
    let lineCount = 0;
    for (const spelling of pathSpellings(text(item.file, 1_000), context.repoDir)) {
      const content = await context.headFile(spelling);
      if (content === null) continue;
      file = spelling;
      lineCount = countLines(content);
      break;
    }
    if (file === null || lineCount === 0) {
      context.log(`${context.seat}: dropped a finding that cites no readable file at head (${text(item.file, 200) || "no file"})`);
      continue;
    }

    // A finding without a usable line points at the first changed line of its file.
    const fallback = context.changed.get(file)?.[0]?.[0] ?? 1;
    const start = Math.min(positiveInteger(item.start_line) ?? fallback, lineCount);
    const end = Math.min(Math.max(positiveInteger(item.end_line) ?? start, start), lineCount);
    const severity = (["high", "medium", "low"] as const).find((level) => level === item.severity) ?? "medium";
    const confidence = Number(item.confidence);

    candidates.push({
      id: `${context.seat}-${String(candidates.length + 1).padStart(2, "0")}`,
      seat: context.seat,
      file,
      startLine: start,
      endLine: end,
      severity,
      title: title || detail.slice(0, 120),
      detail,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
    });
  }
  return candidates;
}

function words(candidate: Candidate): Set<string> {
  return new Set(`${candidate.title} ${candidate.detail}`.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function better(a: Candidate, b: Candidate): boolean {
  if (a.severity !== b.severity) return SEVERITY_RANK[a.severity] < SEVERITY_RANK[b.severity];
  if (a.confidence !== b.confidence) return a.confidence > b.confidence;
  return a.detail.length >= b.detail.length;
}

const NEARBY_LINES = 3;
const DUPLICATE_SIMILARITY = 0.45;

/** Drops a finding when another one covers nearly the same lines in nearly the same words. */
export function dedupe(candidates: Candidate[]): Candidate[] {
  const kept: Array<{ candidate: Candidate; words: Set<string> }> = [];
  for (const candidate of candidates) {
    const candidateWords = words(candidate);
    const twin = kept.findIndex(({ candidate: other, words: otherWords }) =>
      other.file === candidate.file
      && candidate.startLine <= other.endLine + NEARBY_LINES
      && other.startLine <= candidate.endLine + NEARBY_LINES
      && similarity(candidateWords, otherWords) >= DUPLICATE_SIMILARITY);
    if (twin === -1) kept.push({ candidate, words: candidateWords });
    else if (better(candidate, kept[twin]!.candidate)) kept[twin] = { candidate, words: candidateWords };
  }
  return kept.map(({ candidate }) => candidate);
}

export function parseVerdicts(raw: unknown): Verdict[] {
  if (!Array.isArray(raw)) return [];
  const verdicts: Verdict[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const verdict = (["confirmed", "rejected", "uncertain"] as const).find((value) => value === item.verdict);
    if (typeof item.id !== "string" || !verdict) continue;
    verdicts.push({ id: item.id, verdict, duplicateOf: typeof item.duplicate_of === "string" && item.duplicate_of ? item.duplicate_of : null });
  }
  return verdicts;
}

/**
 * Removes rejected findings and findings marked as duplicates of a surviving one.
 * A finding the verifier skipped counts as uncertain. Strict mode keeps only confirmed findings.
 */
export function applyVerdicts(candidates: Candidate[], verdicts: Verdict[], strict: boolean): Candidate[] {
  const byId = new Map(verdicts.map((verdict) => [verdict.id, verdict]));
  const index = new Map(candidates.map((candidate, position) => [candidate.id, position]));
  const passes = (id: string): boolean => {
    const verdict = byId.get(id)?.verdict ?? "uncertain";
    return verdict === "confirmed" || (verdict === "uncertain" && !strict);
  };
  return candidates.filter((candidate, position) => {
    if (!passes(candidate.id)) return false;
    const target = byId.get(candidate.id)?.duplicateOf;
    const targetPosition = target ? index.get(target) : undefined;
    if (!target || targetPosition === undefined || targetPosition === position || !passes(target)) return true;
    // Two findings that name each other as duplicates: keep the earlier one.
    const mutual = byId.get(target)?.duplicateOf === candidate.id;
    return mutual && position < targetPosition;
  });
}

/** Most severe and most confident first, cut to the cap. */
export function rank(candidates: Candidate[], max: number): Candidate[] {
  return candidates
    .map((candidate, position) => ({ candidate, position }))
    .sort((a, b) =>
      SEVERITY_RANK[a.candidate.severity] - SEVERITY_RANK[b.candidate.severity]
      || b.candidate.confidence - a.candidate.confidence
      || a.position - b.position)
    .slice(0, max)
    .map(({ candidate }) => candidate);
}

export function toOutput(candidate: Candidate, producer: string): OutputFinding {
  const title = candidate.title.replace(/[.:]+$/, "");
  const message = candidate.detail && candidate.detail !== candidate.title ? `${title}: ${candidate.detail}` : candidate.title;
  return {
    file: candidate.file,
    start_line: candidate.startLine,
    end_line: candidate.endLine,
    message: message.slice(0, MAX_MESSAGE_CHARS),
    producer,
  };
}
