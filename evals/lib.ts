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

export interface Expectation {
  id: string;
  label: Label;
  /** The problem in one or two sentences, in enough detail to recognise it. */
  what: string;
  file?: string;
  kind?: string;
  min_severity?: Severity;
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
  findings: Expectation[];
}

const SHA = /^[0-9a-f]{40}$/;
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
    if (entry.min_severity !== undefined && !(String(entry.min_severity) in SEVERITY_RANK)) fail(`finding ${String(entry.id)} has an unknown min_severity`);
  }
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
    // A run counts as right when any of its matching findings has the expected kind or severity.
    const hits = runs.map((run) => (run.matches[expectation.id] ?? []).map((index) => run.findings[index]).filter((finding): finding is Finding => Boolean(finding)))
      .filter((found) => found.length);
    return {
      expectation,
      reported: hits.length,
      kindRight: expectation.kind ? hits.filter((found) => found.some((finding) => finding.kind === expectation.kind)).length : null,
      severityRight: expectation.min_severity
        ? hits.filter((found) => found.some((finding) => SEVERITY_RANK[finding.severity]! <= SEVERITY_RANK[expectation.min_severity!]!)).length
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
