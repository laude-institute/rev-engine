// Optional fixes for the findings of a review: for a finding whose remedy is a small
// change to the lines it names, the new text of those lines.
//
// It is kept apart from the review. It runs once the findings are final, never adds,
// removes or reorders a finding, and a finding without a fix is the normal case.
import { runAgent } from "./agent.ts";
import type { Candidate } from "./findings.ts";
import type { Chat } from "./llm.ts";
import { pullRequestSection, UNTRUSTED, type PullRequestInfo } from "./prompts.ts";
import type { ToolDefinition, Workspace } from "./tools.ts";

/** The new text of some lines of a finding's file, as they are at head. */
export interface Fix {
  startLine: number;
  endLine: number;
  /** What replaces those lines, without a final line break. Empty to remove them. */
  replacement: string;
}

/** Writing a few lines takes far fewer turns than a review. */
const MAX_FIX_TURNS = 15;
/** A fix replaces this many lines at most, and is this long at most. A larger change is for the author to write. */
export const MAX_FIX_LINES = 10;
export const MAX_REPLACEMENT_LINES = 15;
const MAX_REPLACEMENT_CHARS = 2_000;
/** A fix starts and ends this close to its finding's lines. */
const NEARBY_LINES = 3;

export const FIX_SYSTEM = `You are a maintainer writing fixes for potential problems a review has reported on one pull request, some of which may be unverified. For each finding, decide whether a small change to the lines it names would resolve it, and if so write that change. The replacement text is saved to the details output for inspection, so a wrong fix is worse than none. Proposing nothing for a finding is always acceptable, and for most findings it is the right answer.

${UNTRUSTED}

Propose a fix only when all of this holds:
- It replaces at most ${MAX_FIX_LINES} consecutive lines of the finding's file, on or right next to the lines the finding names.
- It is complete. Nothing else has to change for it to work: no other file, no other place in this file, no new import outside the replaced lines, no migration, no test that would now fail.
- You have read the lines with read_file, and the code they call or are called from, and you are confident the new text is correct and compiles.
- There is one obvious way to fix it. When the remedy is a design decision, a missing test, a document to write or a choice between alternatives, propose nothing.

How to write it
- start_line and end_line are line numbers of the file as it is after the change, as read_file shows them.
- replacement is the complete new text of those lines: every line, with the file's own indentation and style, and no line numbers. It may have more or fewer lines than it replaces. An empty replacement removes the lines.
- Change only what the fix needs. Do not reformat, rename or tidy anything else.

Then call submit_fixes once, with one entry for each finding you wrote a fix for.`;

export const submitFixes: ToolDefinition = {
  type: "function",
  function: {
    name: "submit_fixes",
    description: "Hand in the fixes. Call this exactly once. The list may be empty.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["fixes"],
      properties: {
        fixes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "start_line", "end_line", "replacement"],
            properties: {
              id: { type: "string", description: "The finding's id, such as F1." },
              start_line: { type: "integer", minimum: 1, description: "First line to replace, in the file after the change." },
              end_line: { type: "integer", minimum: 1, description: "Last line to replace." },
              replacement: { type: "string", description: "The complete new text of those lines." },
            },
          },
        },
      },
    },
  },
};

export function fixPrompt(pr: PullRequestInfo, findings: Candidate[], minutes: number, turns: number): string {
  const listed = findings.map((finding, index) => `<finding id="F${index + 1}" file="${finding.file}" lines="${finding.startLine}-${finding.endLine}" severity="${finding.severity}" kind="${finding.kind}">\n${finding.title}\n${finding.detail}\n</finding>`).join("\n\n");
  return [
    pullRequestSection(pr),
    `Your budget is ${turns} turns and about ${minutes} minutes. A turn can hold many tool calls.`,
    `The review reported the findings below; verify each claim before proposing a fix. Read the code of each before you decide.\n\n${listed}`,
  ].join("\n\n");
}

/**
 * Checks what the model submitted against the findings and the files at head. Returns one entry
 * for each finding, in the same order: its fix, or null. A fix is dropped when it names no
 * finding, lies away from the finding's lines or outside the file, is too large, or changes nothing.
 */
export async function parseFixes(submission: Record<string, unknown>, findings: Candidate[], headFile: (path: string) => Promise<string | null>, log: (message: string) => void): Promise<Array<Fix | null>> {
  const fixes: Array<Fix | null> = findings.map(() => null);
  for (const entry of Array.isArray(submission.fixes) ? submission.fixes : []) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const index = typeof item.id === "string" && /^F\d+$/.test(item.id) ? Number(item.id.slice(1)) - 1 : -1;
    const finding = findings[index];
    if (!finding || fixes[index]) continue;
    const drop = (why: string) => log(`fix for F${index + 1} dropped: ${why}`);
    const start = Number(item.start_line);
    const end = Number(item.end_line);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || typeof item.replacement !== "string") {
      drop("its lines or its text are not usable");
      continue;
    }
    if (end - start + 1 > MAX_FIX_LINES) {
      drop(`it replaces more than ${MAX_FIX_LINES} lines`);
      continue;
    }
    if (start < finding.startLine - NEARBY_LINES || end > finding.endLine + NEARBY_LINES || end < finding.startLine - NEARBY_LINES || start > finding.endLine + NEARBY_LINES) {
      drop("it lies away from the finding's lines");
      continue;
    }
    const replacement = item.replacement.replace(/\r\n/g, "\n").replace(/\n+$/, "");
    if (replacement.length > MAX_REPLACEMENT_CHARS || replacement.split("\n").length > MAX_REPLACEMENT_LINES) {
      drop("its text is too long");
      continue;
    }
    const content = await headFile(finding.file);
    const lines = content === null ? [] : content.replace(/\r\n/g, "\n").split("\n");
    // A file that ends with a line break has one line fewer than the split gives.
    const count = lines.at(-1) === "" ? lines.length - 1 : lines.length;
    if (end > count) {
      drop("it reaches past the end of the file");
      continue;
    }
    if (lines.slice(start - 1, end).join("\n") === replacement) {
      drop("it changes nothing");
      continue;
    }
    fixes[index] = { startLine: start, endLine: end, replacement };
  }
  return fixes;
}

export interface FixOptions {
  chat: Chat;
  model: string;
  pr: PullRequestInfo;
  /** The review's final findings. */
  findings: Candidate[];
  workspace: Workspace;
  deadline: number;
  maxTurns: number;
  log: (message: string) => void;
}

/** Asks for the fixes. A failure is logged and gives none, so it can never sink the review. */
export async function proposeFixes(options: FixOptions): Promise<Array<Fix | null>> {
  const { model, findings, log } = options;
  const none = findings.map(() => null);
  if (!findings.length) return none;
  const turns = Math.min(options.maxTurns, MAX_FIX_TURNS);
  const minutes = Math.max(1, Math.round((options.deadline - Date.now()) / 60_000));
  try {
    const submission = await runAgent({
      chat: options.chat, model, system: FIX_SYSTEM, prompt: fixPrompt(options.pr, findings, minutes, turns),
      workspace: options.workspace, submit: submitFixes, deadline: options.deadline, maxTurns: turns, log,
      caller: `fixes (${model})`,
    });
    const fixes = await parseFixes(submission, findings, (path) => options.workspace.headFile(path), log);
    log(`fixes (${model}): ${fixes.filter(Boolean).length} of ${findings.length} finding(s) got a fix`);
    return fixes;
  } catch (error) {
    log(`fixes (${model}) failed: ${error instanceof Error ? error.message : String(error)}`);
    return none;
  }
}
