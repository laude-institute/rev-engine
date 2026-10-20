// Turns a findings file into the parts of one GitHub pull request review:
// comments on lines the diff shows, and a summary for everything else.

export type Severity = "high" | "medium" | "low";

export interface Finding {
  file: string;
  start_line: number;
  end_line: number;
  severity: Severity;
  kind?: string;
  title: string;
  detail: string;
}

export interface Fit {
  verdict: string;
  summary: string;
  reasons: Array<{ point: string; source: string; detail?: string }>;
}

/** A review comment in the form the GitHub API takes. */
export interface LineComment {
  path: string;
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
  body: string;
}

/** A comment already on the pull request. `line` is null once the code under it has changed. */
export interface ExistingComment {
  id?: number;
  path: string;
  line: number | null;
  start_line: number | null;
  body: string;
  html_url?: string;
}

/** For each file, the line ranges at head that each hunk of the diff shows. */
export type Hunks = Map<string, Array<[number, number]>>;

/** Marks a comment as written by this action, so a later run can recognise it. */
export const MARKER = "<!-- rev-engine-prime -->";

const VERDICTS: Record<string, string> = {
  fits: "It fits the project",
  fits_with_concerns: "It fits, with concerns",
  does_not_fit: "It does not fit the project",
  unclear: "The project states too little to tell",
};

/** GitHub accepts a comment only on a line that a hunk shows, so record what each hunk covers at head. */
export function parseHunks(diff: string): Hunks {
  const hunks: Hunks = new Map();
  let ranges: Array<[number, number]> | null = null;
  let inHeader = false;
  for (const text of diff.split("\n")) {
    if (text.startsWith("diff --git ")) {
      ranges = null;
      inHeader = true;
      continue;
    }
    if (inHeader && text.startsWith("+++ ")) {
      const path = text.slice(4).trim().replace(/^"|"$/g, "");
      if (path !== "/dev/null") {
        ranges = [];
        hunks.set(path.replace(/^b\//, ""), ranges);
      }
      continue;
    }
    const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      inHeader = false;
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (ranges && count > 0) ranges.push([start, start + count - 1]);
    }
  }
  return hunks;
}

/**
 * Where a finding's comment can go: its own lines when one hunk shows them all,
 * otherwise the part of them a hunk does show. Null when no hunk shows any of them.
 */
export function place(finding: Finding, hunks: Hunks): { line: number; startLine: number | null } | null {
  const start = Math.min(finding.start_line, finding.end_line);
  const end = Math.max(finding.start_line, finding.end_line);
  for (const [first, last] of hunks.get(finding.file) ?? []) {
    if (end < first || start > last) continue;
    const from = Math.max(start, first);
    const to = Math.min(end, last);
    return { line: to, startLine: from < to ? from : null };
  }
  return null;
}

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const SEVERITY_LABEL: Record<Severity, string> = { high: "High", medium: "Medium", low: "Low" };
const KIND_LABEL: Record<string, string> = { test: "test coverage", documentation: "documentation", maintainability: "maintainability" };

/** "Medium severity", with the kind added when the finding is something other than a defect in the code. */
function rating(finding: Finding): string {
  const kind = KIND_LABEL[finding.kind ?? ""];
  return `${SEVERITY_LABEL[finding.severity]} severity${kind ? `, ${kind}` : ""}`;
}
/** Keeps a long list of collapsed findings inside the size GitHub allows for a review. */
const MAX_LISTED_DETAIL_CHARS = 1_500;

function titled(finding: Finding): string {
  const title = finding.title.replace(/[.:]+$/, "");
  return finding.detail && finding.detail !== finding.title ? `**${title}.** ${finding.detail}` : `**${title}.**`;
}

export function commentBody(finding: Finding): string {
  const title = finding.title.replace(/[.:]+$/, "");
  const detail = finding.detail && finding.detail !== finding.title ? `\n\n${finding.detail}` : "";
  return `**${rating(finding)}. ${title}.**${detail}\n\n${MARKER}`;
}

/**
 * How alike two texts are in their words, from 0 to 1. A copy of textSimilarity in
 * src/findings.ts, because this folder is mounted on its own; a test keeps the two equal.
 */
export function textSimilarity(a: string, b: string): number {
  const first = new Set(a.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
  const second = new Set(b.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
  if (!first.size || !second.size) return 0;
  let shared = 0;
  for (const word of first) if (second.has(word)) shared += 1;
  return shared / (first.size + second.size - shared);
}

/** The same threshold dedupe in src/findings.ts uses for two findings in nearly the same words. */
const REPEAT_SIMILARITY = 0.45;

/** An earlier comment's title and detail, without its severity label and marker. */
function commentText(body: string): string {
  return body.replace(MARKER, "").replace(/^\s*\*\*(high|medium|low) severity(, [\w -]+)?\.\s*/i, "");
}

/**
 * The earlier comment of this action that already raised this finding: on overlapping
 * lines of the same file and in nearly the same words. A comment whose thread is
 * settled, resolved or answered with a decision, does not count, because the verifier
 * judges repeats of decided findings and a new problem on those lines must be shown.
 */
export function earlierComment(finding: Finding, existing: ExistingComment[], settled: Set<number> = new Set()): ExistingComment | null {
  const start = Math.min(finding.start_line, finding.end_line);
  const end = Math.max(finding.start_line, finding.end_line);
  return existing.find((comment) => {
    if (comment.path !== finding.file || comment.line === null || !comment.body.includes(MARKER)) return false;
    if (comment.id !== undefined && settled.has(comment.id)) return false;
    if ((comment.start_line ?? comment.line) > end || comment.line < start) return false;
    return textSimilarity(`${finding.title} ${finding.detail}`, commentText(comment.body)) >= REPEAT_SIMILARITY;
  }) ?? null;
}

export interface ReviewParts {
  body: string;
  comments: LineComment[];
}

export interface ReviewInput {
  findings: Finding[];
  fit: Fit | null;
  hunks: Hunks;
  existing: ExistingComment[];
  /** Ids of earlier comments whose threads are resolved or answered with a decision. */
  settled?: Set<number>;
  head: string;
  model: string;
  /** Findings at least this severe get a comment. The rest are listed collapsed in the summary. */
  minSeverity: Severity;
  /** Cap on comments. Findings past it join the collapsed list. */
  maxComments: number;
  /** Ids of earlier decided findings that this review's verifier found repeated, one per finding left out. */
  decided?: string[];
}

function location(finding: Finding): string {
  return finding.start_line === finding.end_line ? `${finding.file}:${finding.start_line}` : `${finding.file}:${finding.start_line}-${finding.end_line}`;
}

/** The first `count` sentences of a text, and the rest. */
function sentences(text: string, count: number): { lead: string; rest: string } {
  const parts = text.trim().match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)\s*/g) ?? [text];
  return { lead: parts.slice(0, count).join("").trim(), rest: parts.slice(count).join("").trim() };
}

/**
 * The verdict and a short summary in view, and the reasons with their sources and
 * evidence collapsed, so a person can skim it and an agent can still read all of it.
 */
function fitSection(fit: Fit): string {
  const { lead, rest } = sentences(fit.summary, 2);
  const reasons = fit.reasons.map((reason) => `- ${reason.point}${reason.detail ? ` ${reason.detail}` : ""}${reason.source ? ` (${reason.source})` : ""}`);
  const more = [...(rest ? [rest] : []), ...(reasons.length ? [reasons.join("\n")] : [])];
  const why = reasons.length ? count(reasons.length, "reason") + " with sources" : "More";
  return `#### Does this change belong in the project?\n\n**${VERDICTS[fit.verdict] ?? fit.verdict}.** ${lead}${more.length ? `\n\n<details>\n<summary>${why}</summary>\n\n${more.join("\n\n")}\n\n</details>` : ""}`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function listed(finding: Finding): string {
  const text = titled(finding);
  const cut = text.length > MAX_LISTED_DETAIL_CHARS ? `${text.slice(0, MAX_LISTED_DETAIL_CHARS)}...` : text;
  return `- ${rating(finding)}, \`${location(finding)}\`. ${cut.replace(/\s*\n+\s*/g, " ")}`;
}

/** Why a fit verdict other than "fits" needs a maintainer, in a few words. */
const FIT_QUESTION: Record<string, string> = {
  fits_with_concerns: "The change belongs, but part of it needs a maintainer's call",
  does_not_fit: "The change may not belong in the project",
  unclear: "The project states too little to tell whether the change belongs",
};

/**
 * One line of merge advice, decided by plain rules from the findings and the fit
 * assessment. A question about whether the change belongs comes before any defect.
 */
export function recommendation(findings: Finding[], fit: Fit | null): string {
  const high = findings.filter((finding) => finding.severity === "high").length;
  const medium = findings.filter((finding) => finding.severity === "medium").length;
  let advice: string;
  if (fit && fit.verdict !== "fits") {
    const why = FIT_QUESTION[fit.verdict] ?? "The assessment below questions whether the change belongs in the project";
    advice = `**Recommendation: needs a maintainer's decision.** ${why}${high ? `, and ${count(high, "high severity finding")} should be fixed in any case` : ""}.`;
  } else if (high) {
    advice = `**Recommendation: fix, then merge.** ${count(high, "high severity finding")} should be fixed first.`;
  } else if (medium) {
    advice = `**Recommendation: merge and fast-follow.** ${count(medium, "medium severity finding")} can be fixed after the merge.`;
  } else {
    advice = "**Recommendation: merge.** The review found nothing of medium or high severity.";
  }
  return advice;
}

/**
 * `links` holds the address of each line comment, in the order of the comments
 * this returns. They exist only once the review is posted, so the review is
 * built once without them and its summary is rebuilt with them afterwards.
 */
export function buildReview(input: ReviewInput, links: Array<string | undefined> = []): ReviewParts {
  // The findings arrive most severe first, so the cap keeps the most severe.
  const serious = input.findings.filter((finding) => SEVERITY_RANK[finding.severity] <= SEVERITY_RANK[input.minSeverity]);
  const shown = serious.slice(0, input.maxComments);
  const collapsed = input.findings.filter((finding) => !shown.includes(finding));
  // A finding an open earlier comment already raised is listed with a link to it, never dropped.
  const repeats = shown.flatMap((finding) => {
    const earlier = earlierComment(finding, input.existing, input.settled);
    return earlier ? [{ finding, earlier }] : [];
  });
  const fresh = shown.filter((finding) => !repeats.some((repeat) => repeat.finding === finding));
  const comments: LineComment[] = [];
  const placed: Finding[] = [];
  const unplaced: Finding[] = [];
  for (const finding of fresh) {
    const spot = place(finding, input.hunks);
    if (!spot) {
      unplaced.push(finding);
      continue;
    }
    placed.push(finding);
    comments.push({
      path: finding.file, line: spot.line, side: "RIGHT",
      ...(spot.startLine === null ? {} : { start_line: spot.startLine, start_side: "RIGHT" as const }),
      body: commentBody(finding),
    });
  }

  const level = input.minSeverity === "high" ? "high severity" : input.minSeverity === "medium" ? "medium or high severity" : "any severity";
  const sections = [`### Automated review\n\n${recommendation(input.findings, input.fit)}\n\nReviewed commit ${input.head.slice(0, 7)} with ${input.model}, by reading the code. It did not run the code or look at the checks.`];
  if (input.fit) sections.push(fitSection(input.fit));

  const lines: string[] = [];
  if (!shown.length) lines.push(`No findings of ${level}.`);
  if (placed.length) {
    const items = placed.map((finding, index) => {
      const title = finding.title.replace(/[.:]+$/, "");
      return `- ${rating(finding)}. ${links[index] ? `[${title}](${links[index]})` : title}.`;
    });
    lines.push(`${count(placed.length, "finding")} of ${level}, see the inline ${placed.length === 1 ? "comment" : "comments"}:\n\n${items.join("\n")}`);
  }
  if (repeats.length) {
    const items = repeats.map(({ finding, earlier }) => `${listed(finding)} Already raised in ${earlier.html_url ? `[this comment](${earlier.html_url})` : "an earlier comment"}.`);
    const one = repeats.length === 1;
    lines.push(`<details>\n<summary>${count(repeats.length, "finding")} ${one ? "was" : "were"} not commented again because an earlier review's open comment on the same lines already ${one ? "raises it" : "raises them"}</summary>\n\n${items.join("\n")}\n\n</details>`);
  }
  const decided = input.decided ?? [];
  if (decided.length) lines.push(`${count(decided.length, "finding")} ${decided.length === 1 ? "was" : "were"} left out as already decided by the maintainer in an earlier round (${[...new Set(decided)].join(", ")}).`);
  if (unplaced.length) {
    // These have no comment to click through to, so the titles are in view and the details one click away.
    const titles = unplaced.map((finding) => `- ${rating(finding)}. ${finding.title.replace(/[.:]+$/, "")}. \`${location(finding)}\``);
    lines.push(`${count(unplaced.length, "finding")} about lines the diff does not show:\n\n${titles.join("\n")}\n\n<details>\n<summary>Details of ${unplaced.length === 1 ? "this finding" : `these ${unplaced.length} findings`}</summary>\n\n${unplaced.map(listed).join("\n")}\n\n</details>`);
  }
  if (collapsed.length) {
    const why = serious.length > shown.length ? "less severe or past the limit on comments" : "less severe";
    lines.push(`<details>\n<summary>${count(collapsed.length, "more finding")}, ${why}</summary>\n\n${collapsed.map(listed).join("\n")}\n\n</details>`);
  }
  sections.push(`#### Findings\n\n${lines.join("\n\n")}`);
  return { body: `${sections.join("\n\n")}\n\n${MARKER}`, comments };
}

/** The same review with every comment moved into the summary, for when GitHub rejects a line. */
export function withoutLineComments(parts: ReviewParts): ReviewParts {
  if (!parts.comments.length) return parts;
  const moved = parts.comments.map((comment) => `- \`${comment.path}:${comment.start_line ? `${comment.start_line}-` : ""}${comment.line}\` ${comment.body.replace(MARKER, "").trim().replace(/\n+/g, " ")}`).join("\n");
  return { body: `${parts.body.replace(MARKER, "").trim()}\n\nGitHub did not accept the comments on lines, so they are listed here:\n\n${moved}\n\n${MARKER}`, comments: [] };
}
