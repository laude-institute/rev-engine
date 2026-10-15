// Container entry point: review the mounted pull request and write the findings file.
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describeSettings, loadConfig, type Config } from "./config.ts";
import { createChat, emptyUsage, type Chat, type ChatMessage, type Usage } from "./llm.ts";
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
      cost_usd: Number(usage.costUsd.toFixed(6)),
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
    log(`usage ${caller}: ${spent.calls} model call(s), ${spent.promptTokens} prompt token(s) (${spent.cachedTokens} cached), ${spent.completionTokens} completion token(s), $${spent.costUsd.toFixed(4)}`);
  }
}

/** Each caller's conversation. The tool loop sends its whole message list on every call, so the last list a caller sent is its conversation. */
const transcripts = new Map<string, { model: string; messages: ChatMessage[] }>();

async function writeTranscripts(): Promise<void> {
  if (!config.transcriptOutPath) return;
  const conversations = [...transcripts].map(([caller, { model, messages }]) => ({ caller, model, messages }));
  await writeFile(config.transcriptOutPath, `${JSON.stringify({ nwo: config.nwo, pr_number: config.prNumber, head: config.head, conversations })}\n`);
}

try {
  const send = createChat({ apiKey: config.apiKey, baseUrl: config.baseUrl, effort: config.effort, usage, usageByCaller });
  const chat: Chat = config.transcriptOutPath
    ? (request) => {
      transcripts.set(request.caller ?? request.model, { model: request.model, messages: request.messages });
      return send(request);
    }
    : send;
  const outcome = await (config.naive ? naiveReview : review)(config, chat, log);
  await write(outcome.findings);
  if (config.detailsOutPath) {
    const details = outcome.ranked.map((candidate) => ({
      file: candidate.file, start_line: candidate.startLine, end_line: candidate.endLine,
      severity: candidate.severity, kind: candidate.kind, title: candidate.title, detail: candidate.detail,
    }));
    await writeFile(config.detailsOutPath, `${JSON.stringify({ findings: details }, null, 2)}\n`);
  }
  if (outcome.fit) await writeFile(config.fitOutPath, `${JSON.stringify(outcome.fit, null, 2)}\n`);
  await writeTranscripts();
  logUsageByCaller();
  log(`${outcome.findings.length} finding(s) written (${outcome.proposed} proposed, ${outcome.verified ? "verified" : "not verified"}); ${usage.calls} model call(s), $${usage.costUsd.toFixed(4)}, ${Math.round((Date.now() - started) / 1000)}s`);
} catch (error) {
  log(`failed: ${error instanceof Error ? error.message : String(error)}`);
  logUsageByCaller();
  // The first failure exits non-zero so the benchmark retries. A repeat failure
  // writes an empty list, because one pull request that never succeeds fails the whole run.
  if (config.attempt < 2) process.exit(1);
  log(`attempt ${config.attempt} also produced no review; writing an empty findings list`);
  await write([]);
}
