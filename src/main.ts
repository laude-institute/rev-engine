// Container entry point: review the mounted pull request and write the findings file.
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describeSettings, loadConfig, type Config } from "./config.ts";
import { claudeCodeChat, claudeCodeProblem, claudeLoginProblem } from "./claude-code.ts";
import { createChat, emptyUsage, formatCost, roundedCost, type Chat, type ChatMessage, type Usage } from "./llm.ts";
import type { OutputFinding } from "./findings.ts";
import { naiveReview } from "./naive.ts";
import { review } from "./review.ts";

const log = (message: string): void => console.error(`agent: ${message}`);

let config: Config;
try {
  config = loadConfig(process.env);
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const started = Date.now();
const usage = emptyUsage();
const usageByCaller = new Map<string, Usage>();
log(`reviewing ${config.nwo}#${config.prNumber} at ${config.head.slice(0, 12)}`);
log(`settings: ${describeSettings(config)}`);

// An image built without Claude Code can never review with it, so this is a setup error, not a failed review to retry.
// With a fallback endpoint configured, the whole review runs there instead.
let problem = config.engine === "claude-code" ? await claudeCodeProblem() : null;
if (!problem && config.claudeLogin === "cli") problem = await claudeLoginProblem();
if (config.engine === "claude-code" && !problem) log(config.claudeLogin === "cli" ? "claude-code: signed in with the claude CLI login" : `claude-code: using ${config.claudeLogin === "token" ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY"}`);
if (problem && !config.fallback) {
  log(problem);
  process.exit(2);
}
if (problem) {
  log(`${problem}; reviewing with the fallback ${config.fallback!.model} at ${new URL(config.fallback!.baseUrl).host} instead`);
  // Every pass runs on the fallback model, so the seats, logs and usage name that model.
  const model = config.fallback!.model;
  config = {
    ...config, models: config.models.map(() => model), verifierModel: model, effort: null,
    followUpModel: config.followUpModel && model, fitModel: config.fitModel && model, fixModel: config.fixModel && model,
  };
  log(`settings on the fallback: ${describeSettings(config)}`);
}

async function write(findings: OutputFinding[]): Promise<void> {
  const output = {
    pr: { repo: `https://github.com/${config.nwo}`, pr_number: config.prNumber, base: config.base, head: config.head },
    agent: config.agent,
    findings,
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.promptTokens + usage.completionTokens,
      cached_tokens: usage.cachedTokens,
      time_in_ms: Date.now() - started,
      cost_usd: roundedCost(usage.costUsd),
    },
  };
  // Write beside the target and rename, so a crash never leaves half a file at RB_OUT.
  await mkdir(dirname(config.outPath), { recursive: true });
  const temporary = `${config.outPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`);
  await rename(temporary, config.outPath);
}

/** One line for each seat and for the verifier, so a run shows where its tokens and money went. */
function logUsageByCaller(): void {
  for (const [caller, spent] of usageByCaller) {
    log(`usage ${caller}: ${spent.calls} model call(s), ${spent.promptTokens} prompt token(s) (${spent.cachedTokens} cached), ${spent.completionTokens} completion token(s), ${formatCost(spent.costUsd, 4)}`);
  }
}

/**
 * Each caller's conversation. The tool loop sends its whole message list on every call, so the last
 * list a caller sent is its conversation. Claude Code hands over one list that grows as its pass runs.
 */
const transcripts = new Map<string, { model: string; messages: ChatMessage[] }>();

async function writeTranscripts(): Promise<void> {
  if (!config.transcriptOutPath) return;
  const conversations = [...transcripts].map(([caller, { model, messages }]) => ({ caller, model, messages }));
  await writeFile(config.transcriptOutPath, `${JSON.stringify({ nwo: config.nwo, pr_number: config.prNumber, head: config.head, conversations })}\n`);
}

try {
  const keep = (caller: string, model: string, messages: ChatMessage[]): void => {
    transcripts.set(caller, { model, messages });
  };
  /** Records each caller's conversation, under the caller's name with a suffix when one is given. */
  const kept = (send: Chat, suffix = ""): Chat => config.transcriptOutPath
    ? (request) => {
      keep(`${request.caller ?? request.model}${suffix}`, request.model, request.messages);
      return send(request);
    }
    : send;
  // A pass that falls back keeps claude's conversation too, so the transcript shows why it fell back.
  const fallbackSuffix = problem ? "" : " fallback";
  // Claude's effort levels are not the chat API's, so the fallback uses the endpoint's default.
  const fallbackChat = config.fallback
    ? kept(createChat({ apiKey: config.fallback.apiKey, baseUrl: config.fallback.baseUrl, effort: null, usage, usageByCaller }), fallbackSuffix)
    : null;
  let chat: Chat;
  if (problem && fallbackChat) {
    // Claude cannot run here at all, so every pass goes to the fallback model.
    const model = config.fallback!.model;
    chat = ({ effort: _effort, ...request }) => fallbackChat({ ...request, model });
  } else if (config.engine === "claude-code") {
    // Its chat is not wrapped: runAgent tells the engine by a mark on the chat itself, and never calls it.
    chat = claudeCodeChat({
      effort: config.effort, usage, usageByCaller,
      ...(config.transcriptOutPath ? { transcript: keep } : {}),
      ...(fallbackChat ? { fallback: { chat: ({ effort: _effort, ...request }) => fallbackChat(request), model: config.fallback!.model } } : {}),
    }, log);
  } else {
    chat = kept(createChat({ apiKey: config.apiKey, baseUrl: config.baseUrl, effort: config.effort, usage, usageByCaller }));
  }
  // The swarm is a prototype kept outside src, so it is loaded only when it is turned on.
  const swarmReview = config.swarm ? (await import("../experiments/prototypes/swarm/review.ts")).swarmReview : null;
  const outcome = await (swarmReview ?? (config.naive ? naiveReview : review))(config, chat, log);
  await write(outcome.findings);
  if (config.detailsOutPath) {
    const details = outcome.ranked.map((candidate, index) => {
      const checked = outcome.checks?.[index];
      const fix = outcome.fixes?.[index];
      return {
        file: candidate.file, start_line: candidate.startLine, end_line: candidate.endLine,
        severity: candidate.severity, kind: candidate.kind, title: candidate.title, detail: candidate.detail,
        ...(checked ? { confirmed: checked.confirmed, checks: checked.cast } : {}),
        ...(fix ? { fix: { start_line: fix.startLine, end_line: fix.endLine, replacement: fix.replacement } } : {}),
      };
    });
    const decided = (outcome.decided ?? []).map((repeat) => ({ file: repeat.file, title: repeat.title, repeat_of: repeat.repeatOf }));
    await writeFile(config.detailsOutPath, `${JSON.stringify({ findings: details, ...(decided.length ? { decided } : {}) }, null, 2)}\n`);
  }
  if (outcome.fit) await writeFile(config.fitOutPath, `${JSON.stringify(outcome.fit, null, 2)}\n`);
  if (config.contextOutPath) {
    const context = { nwo: config.nwo, pr_number: config.prNumber, head: config.head, diff_in_prompt: outcome.context.diffInPrompt, readers: outcome.context.readers };
    await writeFile(config.contextOutPath, `${JSON.stringify(context)}\n`);
  }
  await writeTranscripts();
  logUsageByCaller();
  log(`${outcome.findings.length} finding(s) written (${outcome.proposed} proposed, ${outcome.verified ? "verified" : "not verified"}); ${usage.calls} model call(s), ${formatCost(usage.costUsd, 4)}, ${Math.round((Date.now() - started) / 1000)}s`);
} catch (error) {
  log(`failed: ${error instanceof Error ? error.message : String(error)}`);
  logUsageByCaller();
  // The first failure exits non-zero so the benchmark retries. A repeat failure
  // writes an empty list, because one pull request that never succeeds fails the whole run.
  if (config.attempt < 2) process.exit(1);
  log(`attempt ${config.attempt} also produced no review; writing an empty findings list`);
  await write([]);
}
