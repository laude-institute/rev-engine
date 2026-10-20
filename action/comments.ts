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
  reasons: Array<{ point: string; source: string }>;
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
  path: string;
  line: number | null;
  start_line: number | null;
  body: string;
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

/** True when an earlier run of this action already commented on these lines of this file. */
export function alreadyReported(finding: Finding, existing: ExistingComment[]): boolean {
  const start = Math.min(finding.start_line, finding.end_line);
  const end = Math.max(finding.start_line, finding.end_line);
  return existing.some((comment) => {
    if (comment.path !== finding.file || comment.line === null || !comment.body.includes(MARKER)) return false;
    return (comment.start_line ?? comment.line) <= end && comment.line >= start;
  });
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

function fitSection(fit: Fit): string {
  const reasons = fit.reasons.map((reason) => `- ${reason.point}${reason.source ? ` (${reason.source})` : ""}`).join("\n");
  return `#### Does this change belong in the project?\n\n**${VERDICTS[fit.verdict] ?? fit.verdict}.** ${fit.summary}${reasons ? `\n\n${reasons}` : ""}`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function listed(finding: Finding): string {
  const text = titled(finding);
  const cut = text.length > MAX_LISTED_DETAIL_CHARS ? `${text.slice(0, MAX_LISTED_DETAIL_CHARS)}...` : text;
  return `- ${rating(finding)}, \`${location(finding)}\`. ${cut.replace(/\s*\n+\s*/g, " ")}`;
}

/**
 * One line of merge advice, decided by plain rules from the findings and the fit
 * assessment. A question about whether the change belongs comes before any defect.
 */
export function recommendation(findings: Finding[], fit: Fit | null): string {
  const high = findings.filter((finding) => finding.severity === "high").length;
  const medium = findings.filter((finding) => finding.severity === "medium").length;
  let advice: string;
  if (fit && fit.verdict !== "fits") {
    advice = `**Recommendation: needs a maintainer's decision.** The assessment below raises a question about whether the change belongs in the project${high ? `, and ${count(high, "high severity finding")} should be fixed in any case` : ""}.`;
  } else if (high) {
    advice = `**Recommendation: fix, then merge.** ${count(high, "high severity finding")} should be fixed first.`;
  } else if (medium) {
    advice = `**Recommendation: merge and fast-follow.** ${count(medium, "medium severity finding")} can be fixed after the merge.`;
  } else {
    advice = "**Recommendation: merge.** The review found nothing of medium or high severity.";
  }
  return `${advice} The reviewer read the code without running it and did not look at the pull request's checks.`;
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
  const fresh = shown.filter((finding) => !alreadyReported(finding, input.existing));
  const repeated = shown.length - fresh.length;
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
  const sections = [`### Automated review\n\n${recommendation(input.findings, input.fit)}\n\nReviewed commit ${input.head.slice(0, 7)} with ${input.model}.`];
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
  if (repeated) lines.push(`${count(repeated, "finding")} ${repeated === 1 ? "was" : "were"} left out because an earlier review already commented on the same lines.`);
  const decided = input.decided ?? [];
  if (decided.length) lines.push(`${count(decided.length, "finding")} ${decided.length === 1 ? "was" : "were"} left out as already decided by the maintainer in an earlier round (${[...new Set(decided)].join(", ")}).`);
  if (unplaced.length) {
    lines.push(`${count(unplaced.length, "finding")} about lines the diff does not show:\n\n${unplaced.map(listed).join("\n")}`);
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
