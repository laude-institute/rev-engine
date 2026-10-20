// Works out the maintainer's decisions on earlier reviews of a pull request, from
// the reviews, their threads and the review evaluation comments. No network calls
// here, so all of it can be unit tested; collect.ts fetches the data.
import { MARKER } from "./comments.ts";

// The same list as src/prior.ts. The action folder is mounted on its own, so it
// does not import from src.
export const DECISIONS = ["fixed", "partly_fixed", "wont_fix", "deferred", "wrong", "resolved"] as const;
export type Decision = (typeof DECISIONS)[number];

export const MAX_ENTRIES = 30;
export const MAX_REASON_CHARS = 300;

export interface PriorEntry {
  id: string;
  file: string;
  lines_hint?: string;
  title: string;
  decision: Decision;
  reason?: string;
  round: number;
  source: string;
}

export interface PriorDecisions {
  entries: PriorEntry[];
  omitted: number;
}

export interface ReviewRecord {
  id: number;
  author: string;
  body: string;
  submittedAt: string;
}

export interface ThreadComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

export interface ThreadRecord {
  /** The review the thread's first comment belongs to. */
  reviewId: number | null;
  path: string;
  startLine: number | null;
  line: number | null;
  /** The commit the first comment was made on. */
  commit: string | null;
  isResolved: boolean;
  resolvedBy: string | null;
  comments: ThreadComment[];
}

export interface IssueComment {
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

export interface Sources {
  reviews: ReviewRecord[];
  threads: ThreadRecord[];
  comments: IssueComment[];
  /** The account the action posts reviews as. */
  bot: string;
  /** Whether this account may decide findings: write or admin access. */
  canDecide: (login: string) => boolean;
}

/** A decision with the time it was made, so the latest one wins. */
interface Statement {
  decision: Decision;
  reason: string;
  at: string;
  source: string;
}

interface Finding {
  file: string;
  linesHint?: string;
  title: string;
  round: number;
  order: number;
  statements: Statement[];
  resolved: { source: string } | null;
}

const REPLY = /^\s*\**\s*(fixed|partly fixed|won['’]?t fix|deferred|wrong|invalid)\b[\s.:,*]*/i;

function replyDecision(word: string): Decision {
  const lower = word.toLowerCase().replace("’", "'");
  if (lower === "fixed") return "fixed";
  if (lower === "partly fixed") return "partly_fixed";
  if (lower === "deferred") return "deferred";
  if (lower === "wrong" || lower === "invalid") return "wrong";
  return "wont_fix";
}

/** The title of a finding's comment, from its first bold line, such as "**Medium severity. The title.**". */
export function findingTitle(body: string): string {
  const first = body.trim().split("\n")[0] ?? "";
  const bold = /^\*\*(.+?)\*\*/.exec(first)?.[1] ?? first;
  return bold.replace(/^(high|medium|low) severity(, [\w -]+)?\.\s*/i, "").trim();
}

/** Text with its links reduced to their words and cut to MAX_REASON_CHARS. */
export function shortReason(text: string): string {
  const plain = text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s*See the review evaluation\.?\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > MAX_REASON_CHARS ? `${plain.slice(0, MAX_REASON_CHARS - 3).trimEnd()}...` : plain;
}

/**
 * The decision an evaluation's reason states, when it states one. A label of
 * invalid is always "wrong". Otherwise only a reason that opens with the decision,
 * or says "fixed in <commit>", "won't fix" or "is deferred", counts: prose about
 * code that happens to contain the word "fixed" is not a decision.
 */
function evaluationDecision(label: string, reason: string): Decision | null {
  if (label === "invalid") return "wrong";
  const opening = REPLY.exec(reason);
  if (opening) return replyDecision(opening[1]!);
  if (/\bpartly fixed in [0-9a-f]{7}/i.test(reason)) return "partly_fixed";
  if (/\bwon['’]t fix\b/i.test(reason)) return "wont_fix";
  if (/\b(?:is|was|are|were|so it is|that part is) deferred\b/i.test(reason)) return "deferred";
  if (/\bfixed in \[?[0-9a-f]{7}/i.test(reason)) return "fixed";
  return null;
}

interface EvaluationLine {
  label: string;
  title: string;
  reason: string;
  /** The id of the thread's first comment, from a discussion_r link. */
  commentId: number | null;
  file: string;
}

/**
 * The labeled findings in one review evaluation comment. A finding is a bullet,
 * numbered item or table row whose label is in bold at its start, such as
 * "- **valid**. [Title](link). Reason." or "| [Title](link) | **must** | Reason |".
 */
export function evaluationLines(body: string): EvaluationLine[] {
  const found: EvaluationLine[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    let label: string | null = null;
    let rest = "";
    let titleCell = "";
    if (line.startsWith("|")) {
      const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
      const at = cells.findIndex((cell) => /^\*\*(must|valid|invalid)\b[^*]*\*\*/i.test(cell));
      if (at < 0) continue;
      label = /^\*\*(must|valid|invalid)/i.exec(cells[at]!)![1]!.toLowerCase();
      titleCell = cells.slice(0, at).join(" ");
      rest = cells.slice(at + 1).join(" ");
    } else {
      const match = /^(?:[-*]|\d+\.)\s+\*\*(must|valid|invalid)\b[^*]*\*\*[\s.,:;-]*(.*)$/i.exec(line);
      if (!match) continue;
      label = match[1]!.toLowerCase();
      rest = match[2] ?? "";
    }
    const text = `${titleCell} ${rest}`;
    const commentId = Number(/#discussion_r(\d+)/.exec(text)?.[1]) || null;
    // A link is the title only when it opens the item, or fills the cells before the label.
    const opening = titleCell || (rest.trimStart().startsWith("[") ? rest : "");
    const link = /\[([^\]]+)\]\([^)]*\)/.exec(opening);
    let title = link?.[1] ?? "";
    let reason = rest;
    if (!titleCell && link) reason = rest.slice(rest.indexOf(link[0]) + link[0].length);
    if (!title) {
      const sentence = /^(.+?[.!?])(\s|$)/.exec(rest.replace(/^(high|medium|low)( severity)?[.,]\s*/i, ""));
      title = sentence?.[1] ?? rest;
      reason = rest.slice(rest.indexOf(title) + title.length);
    }
    title = title.replace(/^\d+:\s*/, "").replace(/[.\s]+$/, "").trim();
    const file = /`([\w./-]+\.[\w]+|[\w./-]+\/[\w.-]+)(?::[\d-]+)?`/.exec(text)?.[1] ?? "";
    found.push({ label, title, reason: reason.replace(/^[\s.,:;()\d]+/, "").trim(), commentId, file });
  }
  return found;
}

/** Keeps the decisions that suppress repeats first, then the newest rounds, up to the cap. */
function capped(findings: Array<{ entry: Omit<PriorEntry, "id">; order: number }>): { kept: typeof findings; omitted: number } {
  const priority = (decision: Decision): number => (decision === "fixed" ? 2 : decision === "partly_fixed" ? 1 : 0);
  const ranked = [...findings].sort((a, b) => priority(a.entry.decision) - priority(b.entry.decision) || b.entry.round - a.entry.round || a.order - b.order);
  const kept = ranked.slice(0, MAX_ENTRIES).sort((a, b) => a.entry.round - b.entry.round || a.order - b.order);
  return { kept, omitted: findings.length - kept.length };
}

/**
 * The decisions file. Only these count: replies and resolutions on threads of the
 * action's own reviews (those carrying its marker), by someone who may decide, and
 * review evaluation comments by someone who may decide. Unanswered threads are
 * left out, because nobody decided them.
 */
export function collectDecisions(sources: Sources): PriorDecisions {
  const ours = sources.reviews
    .filter((review) => review.author === sources.bot && review.body.includes(MARKER))
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  const roundOf = new Map(ours.map((review, index) => [review.id, index + 1]));
  const findings = new Map<string, Finding>();
  let order = 0;

  for (const thread of sources.threads) {
    const first = thread.comments[0];
    const round = thread.reviewId === null ? undefined : roundOf.get(thread.reviewId);
    if (!first || round === undefined || first.author !== sources.bot) continue;
    const statements: Statement[] = [];
    for (const reply of thread.comments.slice(1)) {
      if (!sources.canDecide(reply.author)) continue;
      const match = REPLY.exec(reply.body);
      if (!match) continue;
      statements.push({ decision: replyDecision(match[1]!), reason: shortReason(reply.body.slice(match[0].length)), at: reply.createdAt, source: reply.url });
    }
    const lines = thread.line === null ? undefined : `${thread.startLine ?? thread.line}-${thread.line}${thread.commit ? ` at ${thread.commit.slice(0, 7)}` : ""}`;
    findings.set(`c${first.id}`, {
      file: thread.path, ...(lines ? { linesHint: lines } : {}), title: findingTitle(first.body), round, order: order++, statements,
      resolved: thread.isResolved && thread.resolvedBy && sources.canDecide(thread.resolvedBy) ? { source: first.url } : null,
    });
  }

  for (const comment of [...sources.comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (!/^\s*##\s*Review evaluation\b/i.test(comment.body) || !sources.canDecide(comment.author)) continue;
    // The evaluation names the review it judged; failing that, it is about the latest review before it.
    const named = Number(/pullrequestreview-(\d+)/.exec(comment.body)?.[1]);
    const round = roundOf.get(named) ?? ours.filter((review) => review.submittedAt <= comment.createdAt).length;
    if (!round) continue;
    for (const line of evaluationLines(comment.body)) {
      const decision = evaluationDecision(line.label, line.reason);
      const key = line.commentId !== null && findings.has(`c${line.commentId}`) ? `c${line.commentId}` : `e${round}:${line.title.toLowerCase()}`;
      const existing = findings.get(key) ?? { file: line.file, title: line.title, round, order: order++, statements: [], resolved: null };
      if (decision) existing.statements.push({ decision, reason: shortReason(line.reason), at: comment.createdAt, source: comment.url });
      findings.set(key, existing);
    }
  }

  const decided: Array<{ entry: Omit<PriorEntry, "id">; order: number }> = [];
  for (const finding of findings.values()) {
    const latest = [...finding.statements].sort((a, b) => a.at.localeCompare(b.at)).at(-1);
    const chosen = latest ?? (finding.resolved ? { decision: "resolved" as const, reason: "", source: finding.resolved.source } : null);
    if (!chosen || !finding.title) continue;
    decided.push({
      order: finding.order,
      entry: {
        file: finding.file, ...(finding.linesHint ? { lines_hint: finding.linesHint } : {}), title: finding.title,
        decision: chosen.decision, ...(chosen.reason ? { reason: chosen.reason } : {}), round: finding.round, source: chosen.source,
      },
    });
  }
  const { kept, omitted } = capped(decided);
  return { entries: kept.map(({ entry }, index) => ({ id: `P${index + 1}`, ...entry })), omitted };
}
