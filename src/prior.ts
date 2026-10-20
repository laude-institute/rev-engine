// The maintainer's decisions on findings from earlier reviews of the same pull
// request, as the action collected them into prior.json. The reviewer is told not
// to report decided findings again, and the verifier marks any it still reports.
import { readFile } from "node:fs/promises";

export const DECISIONS = ["fixed", "partly_fixed", "wont_fix", "deferred", "wrong", "resolved"] as const;
export type Decision = (typeof DECISIONS)[number];

export interface PriorEntry {
  /** P1, P2 and so on, for the verifier to name in repeat_of. */
  id: string;
  file: string;
  /** Where the finding was, such as "40-58 at 35db038". Lines move between commits. */
  lines_hint?: string;
  title: string;
  decision: Decision;
  /** The maintainer's reason, cut to a few hundred characters. */
  reason?: string;
  /** Which review of the pull request reported it, starting at 1. */
  round: number;
  /** A link to where the decision is written. */
  source: string;
}

export interface PriorDecisions {
  entries: PriorEntry[];
  /** Decisions left out to keep the list short. */
  omitted: number;
}

const DESCRIBED: Record<Decision, string> = {
  fixed: "fixed",
  partly_fixed: "partly fixed",
  wont_fix: "won't fix",
  deferred: "deferred",
  wrong: "wrong",
  resolved: "resolved without a stated reason",
};

/** Checks the parsed file and keeps the well-formed entries. Null when nothing usable is left. */
export function parsePrior(raw: unknown): PriorDecisions | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  if (!Array.isArray(item.entries)) return null;
  const entries: PriorEntry[] = [];
  for (const value of item.entries) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const decision = DECISIONS.find((known) => known === entry.decision);
    if (typeof entry.id !== "string" || !entry.id || typeof entry.title !== "string" || !entry.title || !decision) continue;
    entries.push({
      id: entry.id,
      file: typeof entry.file === "string" ? entry.file : "",
      ...(typeof entry.lines_hint === "string" && entry.lines_hint ? { lines_hint: entry.lines_hint } : {}),
      title: entry.title,
      decision,
      ...(typeof entry.reason === "string" && entry.reason ? { reason: entry.reason } : {}),
      round: Number.isInteger(entry.round) ? entry.round as number : 0,
      source: typeof entry.source === "string" ? entry.source : "",
    });
  }
  if (!entries.length) return null;
  return { entries, omitted: Number.isInteger(item.omitted) && (item.omitted as number) > 0 ? item.omitted as number : 0 };
}

/** The decisions file, or null when there is none. A broken file is logged and ignored. */
export async function loadPrior(path: string, log: (message: string) => void): Promise<PriorDecisions | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    const prior = parsePrior(JSON.parse(text));
    log(prior ? `${prior.entries.length} earlier decision(s) on this pull request${prior.omitted ? `, ${prior.omitted} more left out` : ""}` : "the earlier decisions file holds no usable entry");
    return prior;
  } catch (error) {
    log(`ignoring the earlier decisions file: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function entryLine(entry: PriorEntry): string {
  const where = entry.file ? `${entry.file}${entry.lines_hint ? ` (was ${entry.lines_hint})` : ""}` : "file not stated";
  const title = /[.!?]$/.test(entry.title) ? entry.title : `${entry.title}.`;
  return `- ${entry.id}, ${where}, round ${entry.round}: ${title} Decision: ${DESCRIBED[entry.decision]}.${entry.reason ? ` Reason: ${entry.reason}` : ""}`;
}

/** The list itself, shared by the reviewer's and the verifier's sections. */
function entriesBlock(prior: PriorDecisions): string {
  const omitted = prior.omitted ? `\n(${prior.omitted} more decision${prior.omitted === 1 ? " was" : "s were"} left out to keep this list short.)` : "";
  return `<earlier_decisions>\n${prior.entries.map(entryLine).join("\n")}${omitted}\n</earlier_decisions>`;
}

/**
 * The section that tells a reviewer what the maintainer already decided. Kept in
 * its own function so other review modes can add it to their prompts.
 */
export function priorDecisionsSection(prior: PriorDecisions): string {
  return `Earlier reviews of this pull request and the maintainer's decisions. These findings were reported on earlier commits and decided by the maintainer. They are given by file, title and decision; their lines may have moved, so judge by the problem each one describes.

- Do not report again a finding decided as wrong, won't fix, deferred, or resolved, unless the code at head changed in a way that makes it right now.
- Do not report again a finding decided as fixed or partly fixed, unless code at head shows the fix is missing or incomplete.
- Report every other problem as you normally would. These decisions say nothing about code they do not cover.

${entriesBlock(prior)}`;
}

/** The verifier's version: it marks repeats and judges, from the code, whether a repeat may stay. */
export function priorDecisionsVerifierSection(prior: PriorDecisions): string {
  return `Earlier reviews of this pull request reported the findings below, and the maintainer decided each one. Their lines may have moved.

For each finding you check, decide whether it describes the same problem as one of these earlier findings: the same file, and a developer who fixed one would have fixed the other. If it does, set repeat_of to that earlier id. Otherwise set repeat_of to null.

When repeat_of is set, set exception_holds from the code at head, not from what the finding says about itself:
- For an earlier finding decided as fixed or partly fixed: true only when the code at head shows the fix is missing or incomplete.
- For any other decision: true only when the code changed since that review in a way that makes the finding right now.
Otherwise set exception_holds to false. Give the finding its verdict as usual either way.

${entriesBlock(prior)}`;
}
