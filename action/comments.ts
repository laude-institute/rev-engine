// Turns a findings file into the parts of one GitHub pull request review:
// comments on lines the diff shows, and a summary for everything else.

export interface Finding {
  file: string;
  start_line: number;
  end_line: number;
  message: string;
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

/** The finding's message with its opening sentence in bold. */
export function commentBody(finding: Finding): string {
  const split = finding.message.indexOf(": ");
  const text = split > 0 && split < 200
    ? `**${finding.message.slice(0, split)}**\n\n${finding.message.slice(split + 2)}`
    : finding.message;
  return `${text}\n\n${MARKER}`;
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
  minSeverity: string;
}

function location(finding: Finding): string {
  return finding.start_line === finding.end_line ? `${finding.file}:${finding.start_line}` : `${finding.file}:${finding.start_line}-${finding.end_line}`;
}

function fitSection(fit: Fit): string {
  const reasons = fit.reasons.map((reason) => `- ${reason.point}${reason.source ? ` (${reason.source})` : ""}`).join("\n");
  return `#### Does this change belong in the project?\n\n**${VERDICTS[fit.verdict] ?? fit.verdict}.** ${fit.summary}${reasons ? `\n\n${reasons}` : ""}`;
}

export function buildReview(input: ReviewInput): ReviewParts {
  const fresh = input.findings.filter((finding) => !alreadyReported(finding, input.existing));
  const repeated = input.findings.length - fresh.length;
  const comments: LineComment[] = [];
  const unplaced: Finding[] = [];
  for (const finding of fresh) {
    const spot = place(finding, input.hunks);
    if (!spot) {
      unplaced.push(finding);
      continue;
    }
    comments.push({
      path: finding.file, line: spot.line, side: "RIGHT",
      ...(spot.startLine === null ? {} : { start_line: spot.startLine, start_side: "RIGHT" as const }),
      body: commentBody(finding),
    });
  }

  const scope = input.minSeverity === "low" ? "All findings are reported." : `Only findings of ${input.minSeverity} severity${input.minSeverity === "high" ? "" : " or above"} are reported.`;
  const sections = [`### Automated review\n\nReviewed commit ${input.head.slice(0, 7)} with ${input.model}. ${scope}`];
  if (input.fit) sections.push(fitSection(input.fit));

  const lines: string[] = [];
  if (!input.findings.length) lines.push("No findings.");
  if (comments.length) lines.push(`${comments.length} finding(s) are posted as comments on the changed lines.`);
  if (repeated) lines.push(`${repeated} finding(s) were left out because an earlier review already commented on the same lines.`);
  if (unplaced.length) {
    lines.push(`${unplaced.length} finding(s) are about lines the diff does not show:\n\n${unplaced.map((finding) => `- \`${location(finding)}\` ${finding.message}`).join("\n")}`);
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
