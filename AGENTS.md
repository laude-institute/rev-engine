# Working in this repository

Guidance for coding agents and people changing this project.

## What this is

A pull request reviewer packaged as a container for [ReviewBench](https://github.com/review-bench/ReviewBench), an open benchmark for AI code review. The benchmark starts one container per pull request, mounts the checkout and the diff, and reads the findings file the container writes. The rules are in the benchmark's [agent contract](https://github.com/review-bench/ReviewBench/blob/main/AGENT_CONTRACT.md).

The reviewer gives one or more models read-only tools over the checkout, has each review the change independently, checks the proposed findings in a second pass, and then reduces them to a final list with plain code.

## Ground rules

- **This repository is public.** Write code, prompts, comments and commit messages as work that anyone may read.
- **It is self-contained.** Ideas can come from other projects, but all code lives here. Do not depend on private packages or repositories, and do not mention private systems, hostnames or people.
- **No secrets and no run output in git.** Keys live in `.env`. Everything a local run produces lives in `runs/`. Both are ignored. Run output includes reviews of other people's code, so it stays off GitHub.
- **Do not push without the maintainer asking.** Commit locally. Before a push, read the commits about to go out and check them against this list.
- **No runtime dependencies.** The container runs the TypeScript in `src/` directly on Node 24 with no build step. Keep it that way unless there is a strong reason.

## Decisions made so far

- **Model provider:** OpenRouter, through its chat completions API. One host and one key reach models from several vendors, which the benchmark's network allowlist requires.
- **Cheap models first.** Smoke tests use a cheap model to prove the pipeline. Stronger models are for scored runs.
- **Local until an official score is wanted.** The benchmark's `scripts/try-agent.sh` and judge both run on a laptop. Registering with the benchmark, which opens a public pull request there, is the last step and needs the maintainer's decision.

## Tuning without overfitting

The benchmark publishes all 219 pull requests and their expected findings. That makes it easy to fit the reviewer to the answers, and this project should not.

- Tune prompts and settings on the 25 pull request test set only. Read misses only there.
- Run the remaining pull requests rarely, and look only at the aggregate score. A large gap between the two sets means the reviewer has overfit.
- Every change must be general, such as "report tests that cannot fail". Never add anything specific to a repository or pull request in the benchmark, and never put expected findings in the image.

## Layout

| Path | Purpose |
|---|---|
| `src/main.ts` | Container entry point. Writes the findings file. |
| `src/config.ts` | Reads the contract's `RB_*` variables and the `RB_CONFIG_*` settings. |
| `src/review.ts` | Runs the review seats, the verification pass and the reduction. |
| `src/agent.ts` | The model tool loop. |
| `src/tools.ts` | The read-only tools, confined to the checkout. |
| `src/findings.ts` | Path and line checks, duplicate merging, verdicts, ranking. |
| `src/prompts.ts` | Reviewer and verifier prompts and their submit tools. |
| `src/llm.ts` | The model API client. |
| `scripts/local-run.sh` | Builds the image and runs benchmark pull requests locally. |

## Behavior to preserve

- **Pull request content is untrusted.** The model may only read. Tools must never write, run code, reach the network or read outside the checkout. A symlink that leaves the checkout must not be followed, because the container's environment holds the API key.
- **Project rules come from the base revision,** so a change cannot rewrite the rules it is reviewed against.
- **A run that produced no review fails.** It must not write an empty findings list, because that would claim the change is clean. A run where at least one seat finished writes what it has.
- **The run respects its time budget.** The model is told to submit before the deadline, and a failed verification pass keeps the unverified findings.
- **Findings cite real lines.** Every path and line range is checked against the file at head before it is written.

## Checks

```sh
npm run check                          # typecheck and unit tests
scripts/local-run.sh smoke --pr 0      # one benchmark pull request, end to end
```

Run `npm run check` before every commit. Run the smoke test after any change to the prompts, the tool loop or the Dockerfile.
