// Starts an eval case from a pull request, so that collecting one takes a single command.
//
//   node evals/add.ts <owner/repo#number | pull request URL> [--private] [--head <commit>] [--details <details.json>]
//
// It records the pull request's commits and text, and lists the findings of the
// action's most recent review of it as "unlabeled" for a person to label.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Finding } from "../action/comments.ts";
import type { EvalCase, Expectation } from "./lib.ts";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gh = async (...args: string[]): Promise<string> => (await exec("gh", args, { maxBuffer: 64 * 1024 * 1024 })).stdout;

/** The findings file the action saved for its latest review of this pull request, when there is one. */
async function latestDetails(repo: string, pr: number): Promise<{ findings: Finding[]; fit: string | null } | null> {
  try {
    const url = (await gh("api", `repos/${repo}/actions/artifacts?name=rev-engine-prime-pr-${pr}&per_page=1`, "--jq", ".artifacts[0].archive_download_url // \"\"")).trim();
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
/** The commit that was reviewed, when the pull request has moved on since. */
const head = option("--head");

const pull = JSON.parse(await gh("api", `repos/${repo}/pulls/${pr}`)) as { title: string; body: string | null; base: { sha: string }; head: { sha: string } };
const reviewed = detailsPath
  ? { findings: (JSON.parse(await readFile(detailsPath, "utf8")) as { findings: Finding[] }).findings, fit: null }
  : await latestDetails(repo, pr);

const findings: Expectation[] = (reviewed?.findings ?? []).map((finding, index) => ({
  id: `f${index + 1}`,
  label: "unlabeled",
  what: finding.detail ? `${finding.title.replace(/[.:]+$/, "")}. ${finding.detail}` : finding.title,
  file: finding.file,
  ...(finding.kind ? { kind: finding.kind } : {}),
}));
const evalCase: EvalCase = {
  id: `${repo.split("/")[1]}-${pr}`,
  repo, pr, base: pull.base.sha, head: head ?? pull.head.sha, title: pull.title, body: pull.body ?? "",
  source: "",
  findings,
};

const folder = argv.includes("--private") ? "evals/private" : "evals/cases";
const path = join(root, folder, `${evalCase.id}.json`);
if (existsSync(path)) throw new Error(`${folder}/${evalCase.id}.json already exists`);
await mkdir(dirname(path), { recursive: true });
await writeFile(path, `${JSON.stringify(evalCase, null, 2)}\n`);
console.log(`wrote ${folder}/${evalCase.id}.json with ${findings.length} finding(s) to label`);
console.log(reviewed ? `the saved review's fit verdict was ${reviewed.fit ?? "not recorded"}` : "no saved review was found, so the findings list is empty");
console.log(`next: set "source", give each finding the label must, valid or invalid, and add "fit" and "advice" if you have a view`);
