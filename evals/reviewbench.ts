// Turns eval cases into ReviewBench golden files and manifest entries, so the
// benchmark's judging CLI can score reviews of our own pull requests. No file
// access here, so all of it can be unit tested.
import type { Severity } from "../action/comments.ts";
import type { EvalCase, Expectation } from "./lib.ts";

/** One finding in a ReviewBench golden file. */
export interface GoldenEntry {
  file: string;
  start_line: number;
  end_line: number;
  message: string;
  tp_fp: "tp" | "fp";
  severity: Severity;
  category: string;
  tp_fp_justification?: string;
  producer: string;
  source?: Record<string, unknown>;
}

export interface GoldenSet {
  pr_key: string;
  pr: { repo: string; pr_number: number; base: string; head: string };
  findings: GoldenEntry[];
}

/** One pull request in a ReviewBench manifest. */
export interface ManifestEntry {
  repo: string;
  pr_number: number;
  pr_url: string;
  base: string;
  head: string;
  title: string;
  body: string;
  nwo: string;
}

export interface Exported {
  golden: GoldenSet;
  manifest: ManifestEntry;
  /** Findings left out, with the reason, so the case can be completed. */
  skipped: Array<{ id: string; reason: string }>;
}

const CATEGORY_BY_KIND: Record<string, string> = {
  defect: "correctness",
  test: "testing",
  documentation: "documentation",
  maintainability: "maintainability",
};

/** The key ReviewBench files a pull request under, such as "owner_repo_12-abcdef01". */
export function prKey(repo: string, pr: number, head: string): string {
  return `${repo.replace("/", "_")}_${pr}-${head.slice(0, 8)}`;
}

function entry(expectation: Expectation): GoldenEntry | string {
  if (!expectation.file) return "it names no file";
  if (expectation.start_line === undefined || expectation.end_line === undefined) return "it has no start_line and end_line";
  const tp = expectation.label !== "invalid";
  // A true finding needs a judged severity. ReviewBench also wants one on a
  // false finding, where it means little, so those default to low.
  const severity = expectation.severity ?? expectation.min_severity ?? (tp ? undefined : "low");
  if (!severity) return "it has no severity";
  const origins = expectation.found_by ?? [];
  return {
    file: expectation.file,
    start_line: expectation.start_line,
    end_line: expectation.end_line,
    message: expectation.what,
    tp_fp: tp ? "tp" : "fp",
    severity,
    category: expectation.category ?? CATEGORY_BY_KIND[expectation.kind ?? ""] ?? "other",
    ...(expectation.note ? { tp_fp_justification: expectation.note } : {}),
    producer: origins[0]?.producer ?? origins[0]?.type ?? "eval-case",
    source: { type: "eval_case", label: expectation.label, found_by: origins.map((origin) => origin.type), judged_by: expectation.judged_by?.type ?? null },
  };
}

/**
 * The golden set and manifest entry for one case. must and valid findings are
 * true positives and invalid ones are false positives. unlabeled findings, and
 * findings without the location or severity ReviewBench needs, are skipped.
 */
export function toReviewBench(evalCase: EvalCase): Exported {
  const findings: GoldenEntry[] = [];
  const skipped: Exported["skipped"] = [];
  for (const expectation of evalCase.findings) {
    if (expectation.label === "unlabeled") {
      skipped.push({ id: expectation.id, reason: "it is unlabeled" });
      continue;
    }
    const result = entry(expectation);
    if (typeof result === "string") skipped.push({ id: expectation.id, reason: result });
    else findings.push(result);
  }
  const repo = `https://github.com/${evalCase.repo}`;
  const pr = { repo, pr_number: evalCase.pr, base: evalCase.base, head: evalCase.head };
  return {
    golden: { pr_key: prKey(evalCase.repo, evalCase.pr, evalCase.head), pr, findings },
    manifest: { ...pr, pr_url: `${repo}/pull/${evalCase.pr}`, title: evalCase.title, body: evalCase.body, nwo: evalCase.repo },
    skipped,
  };
}
