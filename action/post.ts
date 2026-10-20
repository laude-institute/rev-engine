// Posts the findings of one run to the pull request as a single review.
import { readFile } from "node:fs/promises";
import { buildReview, MARKER, parseHunks, withoutLineComments, type ExistingComment, type Finding, type Fit, type ReviewInput, type ReviewParts, type Severity } from "./comments.ts";
import { isDecisionReply } from "./decisions.ts";

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

const SETTLED = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved comments(first: 50) { nodes { databaseId body } } }
      }
    }
  }
}`;

/**
 * Ids of the action's earlier comments whose threads are resolved or have a reply that
 * states a decision. A new finding on their lines is posted, because the verifier already
 * judged repeats of decided findings. Who replied does not matter here: a settled thread
 * only lets more be posted, never less. On failure every thread counts as open, as before.
 */
async function settledComments(): Promise<Set<number>> {
  const settled = new Set<number>();
  const [owner, name] = nwo.split("/") as [string, string];
  const url = process.env.GITHUB_GRAPHQL_URL?.trim() || `${api}/graphql`;
  try {
    let after: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "rev-engine-prime" },
        body: JSON.stringify({ query: SETTLED, variables: { owner, name, number: Number(number), after } }),
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      type Threads = { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: Array<{ isResolved: boolean; comments: { nodes: Array<{ databaseId: number; body: string }> } }> };
      const result = await response.json() as { data?: { repository?: { pullRequest?: { reviewThreads: Threads } } }; errors?: Array<{ message: string }> };
      if (result.errors?.length) throw new Error(result.errors[0]!.message);
      const threads = result.data?.repository?.pullRequest?.reviewThreads;
      if (!threads) throw new Error("no pull request in the answer");
      for (const thread of threads.nodes) {
        const [first, ...replies] = thread.comments.nodes;
        if (!first || !first.body.includes(MARKER)) continue;
        if (thread.isResolved || replies.some((reply) => isDecisionReply(reply.body))) settled.add(first.databaseId);
      }
      if (!threads.pageInfo.hasNextPage) break;
      after = threads.pageInfo.endCursor;
    }
  } catch (error) {
    log(`could not tell which earlier threads are settled, so all count as open: ${error instanceof Error ? error.message : String(error)}`);
  }
  return settled;
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
    findings: output.findings, fit, hunks: parseHunks(diff), existing: await existingComments(), settled: await settledComments(), head,
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
