# rev-engine-prime

A pull request reviewer packaged as a container for [ReviewBench](https://github.com/review-bench/ReviewBench), an open benchmark for AI code review.

This is early work. It has not been registered with the benchmark and has no published score.

## How it reviews

1. **Independent review.** One or more models each review the change on their own. A model can only read: the diff, files at the head and base revisions, file listings and text search, all confined to the checkout.
2. **Verification.** A second pass checks every proposed finding against the code, rejects the ones that do not hold, and marks repeats.
3. **Reduction.** Plain code checks each path and line range against the file at head, merges duplicates, ranks by severity and confidence, and caps the list.

The pull request's text and code are treated as untrusted input throughout. The project's own instruction files, such as `AGENTS.md` and `CONTRIBUTING.md`, are read from the base revision and given to the reviewer as the rules the change should follow.

## Settings

The container follows the benchmark's [agent contract](https://github.com/review-bench/ReviewBench/blob/main/AGENT_CONTRACT.md). It needs one credential, `OPENROUTER_API_KEY`, and reaches one host, the one in `RB_MODEL_BASE_URL` (`https://openrouter.ai/api/v1` by default).

| Variable | Default | Meaning |
|---|---|---|
| `RB_CONFIG_MODEL` | `openai/gpt-6-luna` | Reviewer model. A comma-separated list runs one independent review per model. |
| `RB_CONFIG_VERIFIER` | first reviewer model | Model for the verification pass. |
| `RB_CONFIG_VERIFY` | `lenient` | `lenient` drops rejected findings, `strict` keeps only confirmed ones, `off` skips the pass. |
| `RB_CONFIG_EFFORT` | provider default | Reasoning effort, for models that accept one. |
| `RB_CONFIG_MAX_FINDINGS` | `25` | Cap on findings per pull request. |
| `RB_CONFIG_TIME_BUDGET` | `780` | Seconds allowed for the whole run. |
| `RB_CONFIG_MAX_TURNS` | `40` | Model turns allowed per review or verification pass. |

## Run it locally

You need Docker, Node 24, `git`, `jq`, a clone of ReviewBench beside this repository, and an OpenRouter key.

```sh
cp .env.example .env                    # then add your key
npm install
npm run check                           # typecheck and unit tests
scripts/local-run.sh smoke --pr 0       # one pull request from the test set
JOBS=5 scripts/local-run.sh first-run   # all 25, five at a time
```

Findings and logs land in `runs/<name>/`, which git ignores. To score them, pass `runs/<name>/findings` to the benchmark's [judging CLI](https://github.com/review-bench/ReviewBench/blob/main/docs/JUDGING.md).

## License

Apache 2.0. See [LICENSE](LICENSE).
