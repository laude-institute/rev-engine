// Replays the merge step of a recorded swarm run, so a change to the merge can be measured
// without reviewing again. It rebuilds each pull request's findings from the run's swarm.json:
// the same word merge, then the merge under test, then the verifiers' recorded votes, then
// the ranking and the cap. Only the merge calls a model.
//
//   node experiments/prototypes/swarm/replay-merge.ts <source-run> <new-run> [--original | --skip-under-cap | --after-verify] [--cap N]
//
// --original reuses the recorded groups instead of asking the model, which should reproduce
// the source run's findings exactly; it checks the replay itself. --skip-under-cap asks the
// model only when more findings than the cap are left after the word merge. --after-verify
// keeps the recorded merge, applies the recorded votes, and asks the model to merge only
// the findings the verifiers kept, and only when there are more of them than the cap.
// --cap sets the most findings written, 40 by default, or none for no cap. A finding the recorded run
// grouped away was never verified, so when it is kept now it takes its group's most common vote.
// Score the new run with JUDGE_MODE=match scripts/score.sh <new-run>.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyVerdicts, dedupe, toOutput, type Candidate, type Verdict } from "../../../src/findings.ts";
import { createChat, emptyUsage, type Chat } from "../../../src/llm.ts";
import { cleanGroups, mergeRepeats, representative } from "./merge.ts";
import { rankBySupport } from "./review.ts";

const [source, target, ...flags] = process.argv.slice(2);
if (!source || !target) {
  console.error("usage: node experiments/prototypes/swarm/replay-merge.ts <source-run> <new-run> [--original]");
  process.exit(2);
}
const original = flags.includes("--original");
const skipUnderCap = flags.includes("--skip-under-cap");
const afterVerify = flags.includes("--after-verify");
const capFlag = flags.indexOf("--cap");
const capText = capFlag === -1 ? "40" : flags[capFlag + 1] ?? "";
const MAX_FINDINGS = capText === "none" ? Infinity : Number(capText);
if (!(MAX_FINDINGS > 0)) {
  console.error("--cap takes a positive number or none");
  process.exit(2);
}
const MERGE_SECONDS = 9;

interface Proposal extends Candidate { caller: string }
interface Trace {
  settings: { model: string; effort: string | null; sort: "latency" | "throughput" | null };
  proposals: Proposal[];
  merges: Array<{ ids: string[]; groups: Array<{ ids: string[] }> }>;
  verification: Array<{ findingId: string; result: Verdict }>;
}

async function chatFor(): Promise<Chat> {
  const env = await readFile(".env", "utf8").catch(() => "");
  const apiKey = process.env.OPENROUTER_API_KEY ?? env.match(/^OPENROUTER_API_KEY=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const usage = emptyUsage();
  const chat = createChat({ apiKey, baseUrl: "https://openrouter.ai/api/v1", effort: null, usage });
  return Object.assign(chat, { usage });
}

const chat = original ? null : await chatFor();
let running = 0;
const queue: Array<() => void> = [];
const run = async <T>(job: () => Promise<T>): Promise<T> => {
  if (running >= 64) await new Promise<void>((resolve) => queue.push(resolve));
  running += 1;
  try {
    return await job();
  } finally {
    running -= 1;
    queue.shift()?.();
  }
};
const runDir = join("runs", source);
const keys = (await readdir(join(runDir, "findings"))).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).sort();
await mkdir(join("runs", target, "findings"), { recursive: true });
let mismatches = 0;
for (const key of keys) {
  const trace = JSON.parse(await readFile(join(runDir, ".try-agent", "out", key, "swarm.json"), "utf8")) as Trace;
  const recorded = JSON.parse(await readFile(join(runDir, "findings", `${key}.json`), "utf8")) as { agent: string; findings: unknown[] };
  const proposals: Candidate[] = trace.proposals.map(({ id, seat, file, startLine, endLine, severity, kind, title, detail, confidence }) =>
    ({ id, seat, file, startLine, endLine, severity, kind, title, detail, confidence }));
  const callerOf = new Map(trace.proposals.map((proposal) => [proposal.id, proposal.caller]));

  // The word merge, with the short ids the run gave its survivors.
  const mergedInto = new Map<string, string>();
  const merged = dedupe(proposals, (dropped, kept) => mergedInto.set(dropped.id, kept.id));
  const shortId = new Map(merged.map((candidate, index) => [candidate.id, `f${index + 1}`]));
  const survivorOf = (id: string): string => {
    let current = id;
    for (let hops = 0; mergedInto.has(current) && hops < proposals.length; hops += 1) current = mergedInto.get(current)!;
    return shortId.get(current)!;
  };
  const survivors = merged.map((candidate) => ({ ...candidate, id: shortId.get(candidate.id)! }));
  const byId = new Map(survivors.map((candidate) => [candidate.id, candidate]));

  // The model merge under test, which adds its groups to `into`.
  const into = new Map<string, string>();
  const modelMerge = async (candidates: Candidate[]): Promise<void> => {
    const settings = trace.settings;
    const swarmChat: Chat = (request) => chat!({ ...request, ...(settings.effort ? { effort: settings.effort } : {}), ...(settings.sort ? { providerSort: settings.sort } : {}) });
    const started = Date.now();
    const result = await mergeRepeats(candidates, {
      chat: swarmChat, model: settings.model, deadline: started + MERGE_SECONDS * 1000, attemptTimeoutMs: MERGE_SECONDS * 1000, run,
      log: (message) => console.log(`  ${key.slice(0, 24)}: ${message}`),
    });
    for (const [from, to] of result.into) into.set(from, to);
    const failed = result.batches.filter((batch) => batch.error).length;
    console.log(`  ${key.slice(0, 24)}: merge took ${((Date.now() - started) / 1000).toFixed(1)}s, ${failed} of ${result.batches.length} batch(es) failed`);
  };
  if (original || afterVerify) {
    for (const batch of trace.merges) {
      const members = batch.ids.map((id) => byId.get(id)).filter((candidate) => candidate !== undefined);
      for (const group of cleanGroups(batch.groups, members)) {
        const kept = representative(group);
        for (const member of group) if (member.id !== kept.id) into.set(member.id, kept.id);
      }
    }
  } else if (!skipUnderCap || survivors.length > MAX_FINDINGS) {
    await modelMerge(survivors);
  }
  const kept = survivors.filter((candidate) => !into.has(candidate.id));
  // A merge after verification can fold a finding into one that was itself folded before.
  const groupOf = (id: string): string => {
    let current = id;
    for (let hops = 0; into.has(current) && hops < survivors.length; hops += 1) current = into.get(current)!;
    return current;
  };

  // Each kept finding's vote: its own, or the most common one in its group.
  const recordedVerdicts = new Map(trace.verification.map((entry) => [entry.findingId, entry.result]));
  const verdicts: Verdict[] = kept.flatMap((candidate) => {
    const own = recordedVerdicts.get(candidate.id);
    if (own) return [own];
    const members = survivors.filter((member) => groupOf(member.id) === candidate.id).flatMap((member) => recordedVerdicts.get(member.id) ?? []);
    if (!members.length) return [];
    const counts = new Map<string, number>();
    for (const member of members) counts.set(member.verdict, (counts.get(member.verdict) ?? 0) + 1);
    const verdict = [...counts].sort((a, b) => b[1] - a[1] || (a[0] === "confirmed" ? -1 : 1))[0]![0] as Verdict["verdict"];
    return [{ id: candidate.id, verdict, duplicateOf: null }];
  });
  let verifiedKept = applyVerdicts(kept, verdicts, false);
  if (afterVerify && verifiedKept.length > MAX_FINDINGS) {
    await modelMerge(verifiedKept);
    verifiedKept = verifiedKept.filter((candidate) => !into.has(candidate.id));
  }

  const support = new Map<string, number>();
  for (const candidate of verifiedKept) {
    support.set(candidate.id, new Set(proposals.filter((proposal) => groupOf(survivorOf(proposal.id)) === candidate.id).map((proposal) => callerOf.get(proposal.id))).size);
  }
  const ranked = rankBySupport(verifiedKept, support, MAX_FINDINGS);
  const findings = ranked.map((candidate) => toOutput(candidate, recorded.agent));
  if (original && MAX_FINDINGS === 40 && JSON.stringify(findings) !== JSON.stringify(recorded.findings)) {
    mismatches += 1;
    console.log(`  ${key}: the replay does not match the recorded findings`);
  }
  console.log(`  ${key.slice(0, 24)}: ${survivors.length} after the word merge, ${kept.length} after the merge, ${verifiedKept.length} verified, ${findings.length} written`);
  await writeFile(join("runs", target, "findings", `${key}.json`), `${JSON.stringify({ ...recorded, findings }, null, 2)}\n`);
}
if (chat) {
  const usage = (chat as Chat & { usage: ReturnType<typeof emptyUsage> }).usage;
  console.log(`merge calls ${usage.calls}, $${usage.costUsd.toFixed(4)}`);
}
if (original) console.log(mismatches ? `${mismatches} pull request(s) differ from the recorded run` : "every pull request matches the recorded run");
