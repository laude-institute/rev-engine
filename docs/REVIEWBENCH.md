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

## Register a configuration

A configuration is one image and a set of labels on the registered reviewer, and the portal at [review-bench.ai](https://review-bench.ai) adds one without another approval. The portal has these limits:

- **The image is pinned by digest**, as `ghcr.io/laude-institute/rev-engine-prime@sha256:...`. The `Build and push` workflow prints the digest of each commit on main in its build step.
- **Each label is one setting.** The benchmark passes `key=value` to the container as `RB_CONFIG_<KEY>=value`, with the key upper-cased and dashes turned into underscores, and it checks that every label value appears in the reviewer's output. The settings line the reviewer logs at the start covers this.
- **A configuration has at most 6 labels.**
- **The row id is at most 64 characters.** The portal builds it from the reviewer id and every label value, lower-cased, with each run of other characters turned into a dash and the parts joined by dashes. `laude-revengine-prime-` uses 22 characters, so the label values and the dashes between them have 42 left. A model id such as `deepseek/deepseek-v4.1-flash-1017` uses 33 of them.
- **Credentials are stored for each configuration.** Check that a new configuration says "credentials stored" before a test run.

Because of the limits, settings that suit a model are defaults rather than labels. The swarm's best settings are its defaults, and `MODEL_DEFAULTS` in [`experiments/prototypes/swarm/review.ts`](../experiments/prototypes/swarm/review.ts) holds the provider and reasoning effort that suit each listed model. The fast swarm needs only `model=deepseek/deepseek-v4.1-flash-1017`, `swarm=on` and `mode=agent`, which make a row id of exactly 64 characters. Before registering, run the pushed image by its digest on one test pull request with only those labels, and check its settings line.

## Run it locally

You need Docker, Node 24, `git`, `jq`, a clone of ReviewBench beside this repository, and an OpenRouter key.

```sh
cp .env.example .env                    # then add your key
npm install
npm run check                           # typecheck and unit tests
scripts/local-run.sh smoke --pr 0       # one pull request from the test set
JOBS=5 scripts/local-run.sh first-run   # all 25, five at a time
```

Findings and logs land in `runs/<name>/`, which git ignores. To score them, run `scripts/score.sh <name>`, which passes `runs/<name>/findings` to the benchmark's [judging CLI](https://github.com/review-bench/ReviewBench/blob/main/docs/JUDGING.md). The judge works on every pull request of a run at once, so a run takes about as long as judging its slowest pull request. Within one pull request it classifies findings one after another, which is the slow part. Give several names, as in `scripts/score.sh try-a-1 try-a-2 try-a-3`, to score those runs at the same time. For a quick experiment, `JUDGE_MODE=match scripts/score.sh <name>` runs only the judge's matching step. Grounded precision and recall, which the leaderboard ranks by, depend only on that step, so this gives the same grounded scores in about a minute for a run of the 25, but no augmented scores. Two matchings of one run differ by about 1 to 2 points of F1, as two full judgings do.

## Try a prompt change cheaply

A full run of the 25 costs about $22 with Opus and takes about 45 minutes. Most of that is the reviewer reading code. To compare reviewer prompts, record one run's conversations, then replay only the reporting step with each prompt:

```sh
JOBS=5 scripts/local-run.sh rec -e RB_CONFIG_MODEL=anthropic/claude-opus-5.5 -e RB_TRANSCRIPT_OUT=/work/out/transcript.json
node scripts/replay.ts rec try-a --prompts path/to/prompts.ts --samples 3
scripts/score.sh try-a-1 try-a-2 try-a-3
```

`--prompts` names a copy of `src/prompts.ts` with the change. For each pull request, the replay keeps the code the reviewer read, swaps in that file's system prompt and submit tool, and asks for the submission once, with no second look and no verification. With Opus, the first sample of a prompt costs about $7 and each later sample about $3, because the later samples of a pull request read its conversation from the prompt cache; a sample takes a few minutes. Samples of one prompt agree closely, and scores from replays are comparable with each other but not with full runs. A replay shows only how a prompt changes the final report. A change that acts on what the reviewer reads, on its second look or on verification will not show up, and a prompt rule can do that even when it reads like a reporting rule, so confirm any change you keep with a full run.
