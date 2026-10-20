// Case files, scoring and the report for the review evals. No model calls and
// no file access here, so all of it can be unit tested.
import { recommendation, type Finding, type Severity } from "../action/comments.ts";

/**
 * must: every review should report it. valid: correct when reported, but not
 * required. invalid: wrong, and should not be reported. unlabeled: waiting for
 * a person to decide; it is ignored when scoring.
 */
export const LABELS = ["must", "valid", "invalid", "unlabeled"] as const;
export type Label = (typeof LABELS)[number];

/**
 * Where a finding came from. rev-engine-prime: this reviewer. other-reviewer:
 * another review tool or model. human-review: a person's review comment.
 * author-fix: inferred from a commit the author made after the review.
 * tool: a linter, type checker or test run. person: found later by a person,
 * such as a bug seen in the browser.
 */
export const ORIGINS = ["rev-engine-prime", "other-reviewer", "human-review", "author-fix", "tool", "person"] as const;
export type OriginType = (typeof ORIGINS)[number];

/**
 * Who decided the label. second-review: another review tool whose verdict was
 * accepted as it stood. agent: a coding agent that judged the findings, such as
 * one triaging a review; confirmed_by says whether a person then agreed.
 */
export const JUDGES = ["maintainer", "author", "teammate", "second-review", "agent"] as const;
export type JudgeType = (typeof JUDGES)[number];
/** The people who can confirm an agent's or another tool's judgment. */
export const CONFIRMERS = ["maintainer", "author", "teammate"] as const;

/** One source that reported the finding, with enough detail to find it again. */
export interface Origin {
  type: OriginType;
  /** A link or id: review URL, comment URL, commit id or tool name. */
  ref?: string;
  /** The model or tool that produced it, such as "anthropic/claude-opus-5.5". */
  producer?: string;
  /** The severity that source gave it, which is not the label's severity. */
  severity?: Severity;
  /** The source's own wording, kept so the case can be rebuilt. */
  text?: string;
  /** The day it was reported, as YYYY-MM-DD. */
  date?: string;
}

export interface Judgment {
  type: JudgeType;
  /** The agent or tool and its model, for agent and second-review judgments. */
  producer?: string;
  /** The person who agreed with an agent's or tool's judgment, when one did. Absent means nobody checked it. */
  confirmed_by?: (typeof CONFIRMERS)[number];
  /** A link or id where the decision is written down, such as a PR comment or a commit. */
  ref?: string;
  /** The judge's own words, when they said something short and to the point. */
  quote?: string;
  /** The day of the decision, as YYYY-MM-DD. */
  date?: string;
}

/** A review whose findings the case was built from. */
export interface ReviewRef {
  /** The reviewer, such as "rev-engine-prime" or "pr-review skill". */
  producer: string;
  /** The model the reviewer used, when known. */
  model?: string;
  /** A link or id for the review. */
  ref?: string;
  /** The full commit id it reviewed. Usually the case's head. */
  commit: string;
  date?: string;
  fit?: string;
  advice?: string;
}

export interface Expectation {
  id: string;
  label: Label;
  /** The problem in one or two sentences, in enough detail to recognise it. */
  what: string;
  file?: string;
  /** Lines in the file at head. ReviewBench export needs both. */
  start_line?: number;
  end_line?: number;
  kind?: string;
  /** How severe the judge says it is. Also the expected minimum when min_severity is not set. */
  severity?: Severity;
  /** The lowest reported severity that counts as right. Defaults to severity. */
  min_severity?: Severity;
  /** A ReviewBench category, such as correctness or testing. Derived from kind on export when unset. */
  category?: string;
  /** Every source that reported it. A finding several sources reported lists each one. */
  found_by?: Origin[];
  judged_by?: Judgment;
  /** The commit that fixed it, when it was fixed. */
  fixed_in?: string;
  /** Who judged it and why, for the next person who reads the case. */
  note?: string;
}

export interface EvalCase {
  id: string;
  repo: string;
  pr: number;
  base: string;
  head: string;
  title: string;
  body: string;
  /** Where the labels came from, such as "the author's reply" or "a second review tool". */
  source: string;
  /** The fit verdict a person would give, when one has been decided. */
  fit?: string;
  /** The merge advice a person would accept, when one has been decided. */
  advice?: string[];
  /** The reviews the findings were collected from. */
  reviews?: ReviewRef[];
  /** Commits the author made after head in response to the reviews, oldest first. */
  fixes?: string[];
  findings: Expectation[];
}

const SHA = /^[0-9a-f]{40}$/;

/** ReviewBench's finding categories, so an exported case uses the same ones. */
export const CATEGORIES = [
  "correctness", "security", "reliability", "maintainability", "testing", "documentation", "performance", "api-architecture", "accessibility", "other",
];
const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** Checks a parsed case file and returns it typed. Throws with the reason when it is malformed. */
export function parseCase(value: unknown, name: string): EvalCase {
  const fail = (reason: string): never => {
    throw new Error(`${name}: ${reason}`);
  };
  const item = (value && typeof value === "object" ? value : fail("not an object")) as Record<string, unknown>;
  for (const key of ["id", "repo", "base", "head", "source"]) if (typeof item[key] !== "string" || !item[key]) fail(`missing ${key}`);
  if (!Number.isInteger(item.pr)) fail("pr is not a number");
  if (!SHA.test(item.base as string) || !SHA.test(item.head as string)) fail("base and head must be full commit ids");
  const findings = Array.isArray(item.findings) ? item.findings : fail("findings is not a list");
  const seen = new Set<string>();
  for (const entry of findings as Array<Record<string, unknown>>) {
    if (typeof entry?.id !== "string" || !entry.id) fail("a finding has no id");
    if (seen.has(entry.id as string)) fail(`two findings share the id ${String(entry.id)}`);
    seen.add(entry.id as string);
    if (!LABELS.includes(entry.label as Label)) fail(`finding ${String(entry.id)} has a label other than ${LABELS.join(", ")}`);
    if (typeof entry.what !== "string" || !entry.what) fail(`finding ${String(entry.id)} has no description in "what"`);
    const named = `finding ${String(entry.id)}`;
    for (const key of ["severity", "min_severity"]) if (entry[key] !== undefined && !(String(entry[key]) in SEVERITY_RANK)) fail(`${named} has an unknown ${key}`);
    for (const key of ["start_line", "end_line"]) if (entry[key] !== undefined && !(Number.isInteger(entry[key]) && (entry[key] as number) > 0)) fail(`${named} has a ${key} that is not a positive whole number`);
    if ((entry.start_line === undefined) !== (entry.end_line === undefined)) fail(`${named} needs both start_line and end_line, or neither`);
    if (typeof entry.start_line === "number" && typeof entry.end_line === "number" && entry.end_line < entry.start_line) fail(`${named} ends before it starts`);
    if (entry.category !== undefined && !CATEGORIES.includes(entry.category as string)) fail(`${named} has a category other than ${CATEGORIES.join(", ")}`);
    if (entry.found_by !== undefined) {
      if (!Array.isArray(entry.found_by)) fail(`${named} has a found_by that is not a list`);
      for (const origin of entry.found_by as Array<Record<string, unknown>>) {
        if (!ORIGINS.includes(origin?.type as OriginType)) fail(`${named} has a found_by type other than ${ORIGINS.join(", ")}`);
        if (origin.severity !== undefined && !(String(origin.severity) in SEVERITY_RANK)) fail(`${named} has a found_by severity that is unknown`);
      }
    }
    if (entry.judged_by !== undefined) {
      const judgment = entry.judged_by as Record<string, unknown>;
      if (!JUDGES.includes(judgment?.type as JudgeType)) fail(`${named} has a judged_by type other than ${JUDGES.join(", ")}`);
      if (judgment.confirmed_by !== undefined && !CONFIRMERS.includes(judgment.confirmed_by as (typeof CONFIRMERS)[number])) fail(`${named} has a confirmed_by other than ${CONFIRMERS.join(", ")}`);
    }
    if (entry.fixed_in !== undefined && !SHA.test(String(entry.fixed_in))) fail(`${named} has a fixed_in that is not a full commit id`);
  }
  if (item.reviews !== undefined) {
    if (!Array.isArray(item.reviews)) fail("reviews is not a list");
    for (const review of item.reviews as Array<Record<string, unknown>>) {
      if (typeof review?.producer !== "string" || !review.producer) fail("a review has no producer");
      if (!SHA.test(String(review.commit))) fail("a review's commit must be a full commit id");
    }
  }
  if (item.fixes !== undefined && !(Array.isArray(item.fixes) && item.fixes.every((commit) => SHA.test(String(commit))))) fail("fixes must be a list of full commit ids");
  return { title: "", body: "", ...item } as unknown as EvalCase;
}

/**
 * One review of one case. `matches` maps an expectation id to the indexes of the
 * reported findings that match it. A review sometimes splits one problem into two
 * findings, so there can be several.
 */
export interface RunResult {
  findings: Finding[];
  fit: string | null;
  costUsd: number;
  seconds: number;
  matches: Record<string, number[]>;
  /** Set when the review or the matching failed; such a run is left out of every count. */
  error?: string;
}

/** The label of the merge advice the action would show, such as "fix, then merge". */
export function adviceLabel(run: RunResult): string {
  const text = recommendation(run.findings, run.fit ? { verdict: run.fit, summary: "", reasons: [] } : null);
  return /Recommendation: (.+?)\.\*\*/.exec(text)?.[1] ?? "";
}

export interface ExpectationScore {
  expectation: Expectation;
  reported: number;
  /** Of the runs that reported it, how many gave the expected kind. Null when the case names no kind. */
  kindRight: number | null;
  severityRight: number | null;
}

export interface CaseScore {
  case: EvalCase;
  runs: number;
  failed: number;
  expectations: ExpectationScore[];
  fitRight: number | null;
  adviceRight: number | null;
  advice: Record<string, number>;
  /** Reported findings that match no expectation, from every run. They are candidates for labeling. */
  unlabeled: Finding[];
  costUsd: number;
}

export function scoreCase(evalCase: EvalCase, results: RunResult[]): CaseScore {
  const runs = results.filter((run) => !run.error);
  const expectations = evalCase.findings.filter((expectation) => expectation.label !== "unlabeled").map((expectation) => {
    const minimum = expectation.min_severity ?? expectation.severity;
    // A run counts as right when any of its matching findings has the expected kind or severity.
    const hits = runs.map((run) => (run.matches[expectation.id] ?? []).map((index) => run.findings[index]).filter((finding): finding is Finding => Boolean(finding)))
      .filter((found) => found.length);
    return {
      expectation,
      reported: hits.length,
      kindRight: expectation.kind ? hits.filter((found) => found.some((finding) => finding.kind === expectation.kind)).length : null,
      severityRight: minimum
        ? hits.filter((found) => found.some((finding) => SEVERITY_RANK[finding.severity]! <= SEVERITY_RANK[minimum]!)).length
        : null,
    };
  });
  const advice: Record<string, number> = {};
  for (const run of runs) advice[adviceLabel(run)] = (advice[adviceLabel(run)] ?? 0) + 1;
  const unlabeled = runs.flatMap((run) => {
    const matched = new Set(Object.values(run.matches).flat());
    return run.findings.filter((_, index) => !matched.has(index));
  });
  return {
    case: evalCase,
    runs: runs.length,
    failed: results.length - runs.length,
    expectations,
    fitRight: evalCase.fit ? runs.filter((run) => run.fit === evalCase.fit).length : null,
    adviceRight: evalCase.advice ? runs.filter((run) => evalCase.advice!.includes(adviceLabel(run))).length : null,
    advice,
    unlabeled,
    costUsd: results.reduce((sum, run) => sum + run.costUsd, 0),
  };
}

export interface Totals {
  mustReported: number;
  mustPossible: number;
  validReported: number;
  validPossible: number;
  invalidReported: number;
  invalidPossible: number;
  kindRight: number;
  kindChecked: number;
  severityRight: number;
  severityChecked: number;
  fitRight: number;
  fitChecked: number;
  adviceRight: number;
  adviceChecked: number;
}

export function totals(scores: CaseScore[]): Totals {
  const sum: Totals = {
    mustReported: 0, mustPossible: 0, validReported: 0, validPossible: 0, invalidReported: 0, invalidPossible: 0,
    kindRight: 0, kindChecked: 0, severityRight: 0, severityChecked: 0, fitRight: 0, fitChecked: 0, adviceRight: 0, adviceChecked: 0,
  };
  for (const score of scores) {
    for (const entry of score.expectations) {
      const label = entry.expectation.label as "must" | "valid" | "invalid";
      sum[`${label}Reported`] += entry.reported;
      sum[`${label}Possible`] += score.runs;
      if (label === "invalid") continue;
      if (entry.kindRight !== null) { sum.kindRight += entry.kindRight; sum.kindChecked += entry.reported; }
      if (entry.severityRight !== null) { sum.severityRight += entry.severityRight; sum.severityChecked += entry.reported; }
    }
    if (score.fitRight !== null) { sum.fitRight += score.fitRight; sum.fitChecked += score.runs; }
    if (score.adviceRight !== null) { sum.adviceRight += score.adviceRight; sum.adviceChecked += score.runs; }
  }
  return sum;
}

const ratio = (part: number, whole: number): string => (whole ? `${part} of ${whole}` : "none checked");
const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\s+/g, " ");

export function renderReport(name: string, settings: string, scores: CaseScore[], judgeCostUsd: number): string {
  const sum = totals(scores);
  const reviewCost = scores.reduce((total, score) => total + score.costUsd, 0);
  const lines = [
    `# Eval run ${name}`,
    "",
    settings,
    `Review cost $${reviewCost.toFixed(2)}, matching cost $${judgeCostUsd.toFixed(2)}.`,
    "",
    "## Totals",
    "",
    "Each count is over every run of every case.",
    "",
    `- Findings every review should report: ${ratio(sum.mustReported, sum.mustPossible)} reported.`,
    `- Findings that are correct but optional: ${ratio(sum.validReported, sum.validPossible)} reported.`,
    `- Findings known to be wrong: ${ratio(sum.invalidReported, sum.invalidPossible)} reported. Lower is better.`,
    `- Kind as expected, when reported: ${ratio(sum.kindRight, sum.kindChecked)}.`,
    `- Severity at or above the expected level, when reported: ${ratio(sum.severityRight, sum.severityChecked)}.`,
    `- Fit verdict as expected: ${ratio(sum.fitRight, sum.fitChecked)}.`,
    `- Merge advice among the accepted ones: ${ratio(sum.adviceRight, sum.adviceChecked)}.`,
  ];
  for (const score of scores) {
    lines.push("", `## ${score.case.id}`, "", `${score.case.repo}#${score.case.pr}, ${score.runs} run(s)${score.failed ? `, ${score.failed} failed` : ""}. Labels from: ${score.case.source.replace(/\.$/, "")}.`, "");
    if (score.expectations.length) {
      lines.push("| Finding | Label | Reported | Kind right | Severity right |", "|---|---|---|---|---|");
      for (const entry of score.expectations) {
        const checked = (right: number | null): string => (right === null || !entry.reported ? "" : `${right} of ${entry.reported}`);
        lines.push(`| ${cell(entry.expectation.id)}: ${cell(entry.expectation.what).slice(0, 140)} | ${entry.expectation.label} | ${entry.reported} of ${score.runs} | ${checked(entry.kindRight)} | ${checked(entry.severityRight)} |`);
      }
      lines.push("");
    }
    const given = Object.entries(score.advice).map(([label, count]) => `"${label}" in ${count}`).join(", ");
    if (score.fitRight !== null) lines.push(`Fit verdict "${score.case.fit}": ${score.fitRight} of ${score.runs}.`);
    lines.push(`Merge advice given: ${given || "none"}.${score.adviceRight === null ? "" : ` Accepted in ${score.adviceRight} of ${score.runs}.`}`);
    if (score.unlabeled.length) {
      lines.push("", `Reported findings that match no labeled finding, ${score.unlabeled.length} across the runs. Label the ones that recur:`, "");
      for (const finding of score.unlabeled) lines.push(`- ${finding.severity}, ${finding.kind ?? "no kind"}, \`${finding.file}:${finding.start_line}\`. ${cell(finding.title)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
