// Container entry point: review the mounted pull request and write the findings file.
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describeSettings, loadConfig, type Config } from "./config.ts";
import { createChat, emptyUsage } from "./llm.ts";
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
log(`reviewing ${config.nwo}#${config.prNumber} at ${config.head.slice(0, 12)}`);
log(`settings: ${describeSettings(config)}`);

try {
  const chat = createChat({ apiKey: config.apiKey, baseUrl: config.baseUrl, effort: config.effort, usage });
  const outcome = await review(config, chat, log);
  const output = {
    pr: { repo: `https://github.com/${config.nwo}`, pr_number: config.prNumber, base: config.base, head: config.head },
    agent: config.agent,
    findings: outcome.findings,
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
  log(`${outcome.findings.length} finding(s) written (${outcome.proposed} proposed, ${outcome.verified ? "verified" : "not verified"}); ${usage.calls} model call(s), $${usage.costUsd.toFixed(4)}, ${Math.round((Date.now() - started) / 1000)}s`);
} catch (error) {
  log(`failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
