# ReviewBench

The reviewer is packaged as a container for [ReviewBench](https://github.com/review-bench/ReviewBench), an open benchmark for AI code review. It is registered with the benchmark as Laude RevEngine Prime, reviewing with `anthropic/claude-opus-5.5`.

The benchmark starts one container per pull request, mounts the checkout and the diff, and reads the findings file the container writes. The container follows the benchmark's [agent contract](https://github.com/review-bench/ReviewBench/blob/main/AGENT_CONTRACT.md). Its settings are in [SETTINGS.md](SETTINGS.md).

## Results

On the [leaderboard](https://review-bench.ai) as of October 16, 2026, the registered image ranks first of 11 agents on all 219 pull requests, averaged over three rounds:

| Grounded F1 | Precision | Recall | Mean review time |
|---|---|---|---|
| 59.6% | 83.6% | 46.3% | 3m 2s |

The registered image was built from commit [`b7d795c`](https://github.com/laude-institute/rev-engine/commit/b7d795c0eab5de6d6f4c3064bee5a23c1ac1c5e5). The code has changed since then, so later versions may score differently. See the [announcement on X](https://x.com/LaudeInstitute/status/2111263666763116982).

Prompts and settings were tuned only on the benchmark's 25 pull request test set. The other 194 were checked only as part of the full run's total.

## Run it locally

You need Docker, Node 24, `git`, `jq`, a clone of ReviewBench beside this repository, and an OpenRouter key.

```sh
cp .env.example .env                    # then add your key
npm install
npm run check                           # typecheck and unit tests
scripts/local-run.sh smoke --pr 0       # one pull request from the test set
JOBS=5 scripts/local-run.sh first-run   # all 25, five at a time
```

Findings and logs land in `runs/<name>/`, which git ignores. To score them, run `scripts/score.sh <name>`, which passes `runs/<name>/findings` to the benchmark's [judging CLI](https://github.com/review-bench/ReviewBench/blob/main/docs/JUDGING.md).

## Try a prompt change cheaply

A full run of the 25 costs about $22 with Opus and takes about 45 minutes. Most of that is the reviewer reading code. To compare reviewer prompts, record one run's conversations, then replay only the reporting step with each prompt:

```sh
JOBS=5 scripts/local-run.sh rec -e RB_CONFIG_MODEL=anthropic/claude-opus-5.5 -e RB_TRANSCRIPT_OUT=/work/out/transcript.json
node scripts/replay.ts rec try-a --prompts path/to/prompts.ts --samples 3
scripts/score.sh try-a-1                # and try-a-2, try-a-3
```

`--prompts` names a copy of `src/prompts.ts` with the change. For each pull request, the replay keeps the code the reviewer read, swaps in that file's system prompt and submit tool, and asks for the submission once, with no second look and no verification. With Opus, the first sample of a prompt costs about $7 and each later sample about $3, because the later samples of a pull request read its conversation from the prompt cache; a sample takes a few minutes. Samples of one prompt agree closely, and scores from replays are comparable with each other but not with full runs. A replay shows only how a prompt changes the final report. A change that acts on what the reviewer reads, on its second look or on verification will not show up, and a prompt rule can do that even when it reads like a reporting rule, so confirm any change you keep with a full run.
