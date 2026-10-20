// Posts the findings of one run to the pull request as a single review.
import { readFile } from "node:fs/promises";
import { buildReview, parseHunks, withoutLineComments, type ExistingComment, type Finding, type Fit, type ReviewInput, type ReviewParts, type Severity } from "./comments.ts";

const log = (message: string): void => console.error(`post: ${message}`);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const token = required("GITHUB_TOKEN");
const api = (process.env.GITHUB_API_URL?.trim() || "https://api.github.com").replace(/\/+$/, "");
const nwo = required("RB_NWO");
const number = required("RB_PR_NUMBER");
const head = required("RB_HEAD");

async function github(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${api}/repos/${nwo}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "rev-engine-prime",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function existingComments(): Promise<ExistingComment[]> {
  const comments: ExistingComment[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const response = await github("GET", `/pulls/${number}/comments?per_page=100&page=${page}`);
    if (!response.ok) throw new Error(`listing comments failed with status ${response.status}`);
    const batch = await response.json() as ExistingComment[];
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  return comments;
}

async function submit(parts: ReviewParts): Promise<Response> {
  return github("POST", `/pulls/${number}/reviews`, { commit_id: head, event: "COMMENT", body: parts.body, comments: parts.comments });
}

/**
 * A comment has no address until the review is posted, so the summary's list
 * gets its links in a second step. A failure here leaves the list without links.
 */
async function linkComments(input: ReviewInput, parts: ReviewParts, review: number): Promise<void> {
  try {
    const response = await github("GET", `/pulls/${number}/reviews/${review}/comments?per_page=100`);
    if (!response.ok) throw new Error(`listing the review's comments failed with status ${response.status}`);
    const posted = await response.json() as Array<{ path: string; body: string; html_url: string }>;
    const links = parts.comments.map((comment) => posted.find((other) => other.path === comment.path && other.body.trim() === comment.body.trim())?.html_url);
    const update = await github("PUT", `/pulls/${number}/reviews/${review}`, { body: buildReview(input, links).body });
    if (!update.ok) throw new Error(`updating the summary failed with status ${update.status}`);
  } catch (error) {
    log(`the summary has no links to its comments: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function optionalJson<T>(path: string | undefined): Promise<T | null> {
  if (!path) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

try {
  const minSeverity = (process.env.MIN_SEVERITY?.trim() || "medium") as Severity;
  if (!["high", "medium", "low"].includes(minSeverity)) throw new Error("min-severity must be high, medium or low");
  const maxComments = Number(process.env.MAX_COMMENTS?.trim() || "10");
  if (!Number.isInteger(maxComments) || maxComments < 0) throw new Error("max-findings must be a whole number");
  const output = JSON.parse(await readFile(required("FINDINGS_PATH"), "utf8")) as { findings: Finding[]; decided?: Array<{ repeat_of?: unknown }> };
  const fit = await optionalJson<Fit>(process.env.FIT_PATH);
  const diff = await readFile(required("DIFF_PATH"), "utf8");
  const input = {
    findings: output.findings, fit, hunks: parseHunks(diff), existing: await existingComments(), head,
    model: process.env.REVIEW_MODEL?.trim() || "a model", minSeverity, maxComments,
    decided: (output.decided ?? []).flatMap((repeat) => typeof repeat.repeat_of === "string" ? [repeat.repeat_of] : []),
  };
  const parts = buildReview(input);

  let inline = parts.comments.length > 0;
  let response = await submit(parts);
  if (response.status === 422 && parts.comments.length) {
    // One line GitHub will not take rejects the whole review, so send it again as a summary only.
    log(`GitHub rejected the line comments: ${(await response.text()).slice(0, 500)}`);
    response = await submit(withoutLineComments(parts));
    inline = false;
  }
  if (!response.ok) throw new Error(`posting the review failed with status ${response.status}: ${(await response.text()).slice(0, 500)}`);
  if (inline) await linkComments(input, parts, (await response.json() as { id: number }).id);
  log(`posted a review with ${inline ? parts.comments.length : 0} line comment(s) on ${nwo}#${number}`);
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
