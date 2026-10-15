# ReviewBench

The reviewer is packaged as a container for [ReviewBench](https://github.com/review-bench/ReviewBench), an open benchmark for AI code review. It is registered with the benchmark as Laude RevEngine Prime, reviewing with `anthropic/claude-opus-5.5`.

The benchmark starts one container per pull request, mounts the checkout and the diff, and reads the findings file the container writes. The container follows the benchmark's [agent contract](https://github.com/review-bench/ReviewBench/blob/main/AGENT_CONTRACT.md). Its settings are in [SETTINGS.md](SETTINGS.md).

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
