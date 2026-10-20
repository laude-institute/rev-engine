// Starts an eval case from a pull request, so that collecting one takes a single command.
//
//   node evals/add.ts <owner/repo#number | pull request URL> [--private] [--review <review id>] [--head <commit>] [--details <details.json>]
//
// It records the pull request's commits and text, and lists the findings of the
// action's review of it as "unlabeled" for a person to label. Each finding keeps
// its lines and the review's own wording and severity, so the case can be rebuilt.
// Without --review it uses the action's most recent review.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Finding } from "../action/comments.ts";
import type { EvalCase, Expectation, ReviewRef } from "./lib.ts";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gh = async (...args: string[]): Promise<string> => (await exec("gh", args, { maxBuffer: 64 * 1024 * 1024 })).stdout;

interface ActionReview {
  id: number;
  url: string;
  submittedAt: string;
  /** The full id of the commit the review names. */
  commit: string;
  model?: string;
}

/** The action's review of this pull request: the one named, or the latest. Null when there is none. */
async function actionReview(repo: string, pr: number, id?: string): Promise<ActionReview | null> {
  const reviews = JSON.parse(await gh("api", "--paginate", "--slurp", `repos/${repo}/pulls/${pr}/reviews`)) as Array<Array<{ id: number; html_url: string; submitted_at: string; body: string }>>;
  const ours = reviews.flat().filter((review) => review.body.includes("<!-- rev-engine-prime -->") && (!id || String(review.id) === id));
  const review = ours.at(-1);
  if (!review) {
    if (id) throw new Error(`review ${id} is not a review by the action on ${repo}#${pr}`);
    return null;
  }
  const named = /Reviewed commit ([0-9a-f]{7,40}) with ([^\s]+?)\.?(?:\s|$)/.exec(review.body);
  const commit = named ? (await gh("api", `repos/${repo}/commits/${named[1]}`, "--jq", ".sha")).trim() : "";
  return { id: review.id, url: review.html_url, submittedAt: review.submitted_at, commit, ...(named?.[2] ? { model: named[2] } : {}) };
}

/**
 * The findings file the action saved for a review of this pull request: the
 * newest one saved before the review was posted, or the newest of all.
 */
async function savedDetails(repo: string, pr: number, before?: string): Promise<{ findings: Finding[]; fit: string | null } | null> {
  try {
    const artifacts = JSON.parse(await gh("api", `repos/${repo}/actions/artifacts?name=rev-engine-prime-pr-${pr}&per_page=50`, "--jq", ".artifacts")) as Array<{ created_at: string; archive_download_url: string }>;
    const url = artifacts.filter((artifact) => !before || artifact.created_at <= before).sort((a, b) => b.created_at.localeCompare(a.created_at))[0]?.archive_download_url;
    if (!url) return null;
    const directory = await mkdtemp(join(tmpdir(), "eval-add-"));
    const { stdout } = await exec("gh", ["api", url], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
    await writeFile(join(directory, "artifact.zip"), stdout);
    await exec("unzip", ["-o", "-q", join(directory, "artifact.zip"), "-d", directory]);
    const details = JSON.parse(await readFile(join(directory, "details.json"), "utf8")) as { findings: Finding[] };
    const fit = await readFile(join(directory, "fit.json"), "utf8").then((text) => (JSON.parse(text) as { verdict: string }).verdict, () => null);
    return { findings: details.findings, fit };
  } catch {
    return null;
  }
}

const argv = process.argv.slice(2);
const reference = argv.find((value, index) => !value.startsWith("--") && !["--details", "--head"].includes(argv[index - 1] ?? "")) ?? "";
const parsed = /^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)(?:#|\/pull\/)(\d+)/.exec(reference);
if (!parsed) throw new Error("name a pull request as owner/repo#number or by its URL");
const repo = parsed[1]!;
const pr = Number(parsed[2]);
const option = (name: string): string | undefined => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const detailsPath = option("--details");
const review = await actionReview(repo, pr, option("--review"));
/** The commit that was reviewed. The review names it; --head overrides that. */
const head = option("--head") ?? (review?.commit || undefined);

const pull = JSON.parse(await gh("api", `repos/${repo}/pulls/${pr}`)) as { title: string; body: string | null; base: { sha: string }; head: { sha: string } };
// Allow a few minutes after the review was posted, since the files are saved by the same job.
const before = review ? new Date(new Date(review.submittedAt).getTime() + 10 * 60_000).toISOString() : undefined;
const reviewed = detailsPath
  ? { findings: (JSON.parse(await readFile(detailsPath, "utf8")) as { findings: Finding[] }).findings, fit: null }
  : await savedDetails(repo, pr, before);
const caseHead = head ?? pull.head.sha;
const date = review?.submittedAt.slice(0, 10);

const findings: Expectation[] = (reviewed?.findings ?? []).map((finding, index) => {
  const text = finding.detail ? `${finding.title.replace(/[.:]+$/, "")}. ${finding.detail}` : finding.title;
  return {
    id: `f${index + 1}`,
    label: "unlabeled",
    what: text,
    file: finding.file,
    start_line: finding.start_line,
    end_line: finding.end_line,
    ...(finding.kind ? { kind: finding.kind } : {}),
    found_by: [{
      type: "rev-engine-prime",
      ...(review ? { ref: review.url } : {}),
      ...(review?.model ? { producer: review.model } : {}),
      severity: finding.severity,
      text,
      ...(date ? { date } : {}),
    }],
  };
});
const reviews: ReviewRef[] = review ? [{
  producer: "rev-engine-prime",
  ...(review.model ? { model: review.model } : {}),
  ref: review.url,
  commit: caseHead,
  ...(date ? { date } : {}),
  ...(reviewed?.fit ? { fit: reviewed.fit } : {}),
}] : [];
const after = (await gh("api", "--paginate", `repos/${repo}/pulls/${pr}/commits`, "--jq", ".[].sha")).trim().split("\n").filter(Boolean);
const fixes = after.includes(caseHead) ? after.slice(after.indexOf(caseHead) + 1) : [];
const evalCase: EvalCase = {
  id: `${repo.split("/")[1]}-${pr}`,
  repo, pr, base: pull.base.sha, head: caseHead, title: pull.title, body: pull.body ?? "",
  source: "",
  ...(reviews.length ? { reviews } : {}),
  ...(fixes.length ? { fixes } : {}),
  findings,
};

const folder = argv.includes("--private") ? "evals/private" : "evals/cases";
const path = join(root, folder, `${evalCase.id}.json`);
if (existsSync(path)) throw new Error(`${folder}/${evalCase.id}.json already exists`);
await mkdir(dirname(path), { recursive: true });
await writeFile(path, `${JSON.stringify(evalCase, null, 2)}\n`);
console.log(`wrote ${folder}/${evalCase.id}.json with ${findings.length} finding(s) to label`);
console.log(review ? `review ${review.url} of ${caseHead.slice(0, 7)}` : "no review by the action was found");
console.log(reviewed ? `the saved review's fit verdict was ${reviewed.fit ?? "not recorded"}` : "no saved review was found, so the findings list is empty");
if (fixes.length) console.log(`${fixes.length} commit(s) came after the review: ${fixes.map((commit) => commit.slice(0, 7)).join(", ")}`);
console.log(`next: set "source", give each finding a label, judged_by and severity, add findings from other sources with their found_by, and add "fit" and "advice" if you have a view`);
