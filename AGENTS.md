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
- **Two review modes, one for agents and one for people.** Agent mode writes a review for an agent that manages the pull request. It keeps every finding the verifiers did not reject, with no cap, and starts each message with the finding's severity and how sure the reviewer is, so the agent can choose what to act on. Human mode writes a review for people to read. It keeps only the findings the verifiers confirmed, under a cap. Neither mode reports a claim the verifiers rejected. The benchmark runs agent mode, because ReviewBench's scoring is tuned to reward a more thorough review. Our own pull requests use human mode for now, and will move to agent mode as agents take over more of our code work.
- **Local until an official score is wanted.** The benchmark's `scripts/try-agent.sh` and judge both run on a laptop. Registering with the benchmark, which opens a public pull request there, is the last step and needs the maintainer's decision.

## Tuning without overfitting

The goal is a reviewer we use for our own pull requests. The benchmark score is one measure of that, not the goal.

The benchmark publishes all 219 pull requests and their expected findings. That makes it easy to fit the reviewer to the answers, and this project should not.

- Tune prompts and settings on the 25 pull request test set only. Read misses only there.
- Run the remaining pull requests rarely, and look only at the aggregate score. A large gap between the two sets means the reviewer has overfit.
- The cases in `evals/` are both regression checks and a score to improve, because they are reviews of the pull requests we use the reviewer on. A change that helps them must still be general. As the set grows, keep some cases aside that are only checked, so a gain is confirmed on cases the change was not tuned on.
- Every change must be general, such as "report tests that cannot fail". Never add anything specific to a repository or pull request in the benchmark, and never put expected findings in the image.

## Layout

| Path | Purpose |
|---|---|
| `src/main.ts` | Container entry point. Writes the findings file. |
| `src/config.ts` | Reads the contract's `RB_*` variables and the `RB_CONFIG_*` settings. |
| `src/review.ts` | Runs the review seats, the verification pass and the reduction. |
| `src/agent.ts` | The model tool loop. |
| `src/tools.ts` | The read-only tools, confined to the checkout. |
| `src/docs.ts` | Picks the design documents to offer the reviewer. |
| `src/findings.ts` | Path and line checks, duplicate merging, verdicts, ranking. |
| `src/prompts.ts` | Reviewer and verifier prompts and their submit tools. |
| `src/llm.ts` | The model API client. |
| `src/prior.ts` | Reads those earlier decisions and writes the prompt sections that carry them. |
| `src/fit.ts` | The optional assessment of whether a change belongs in the project. |
| `action.yml` | The GitHub Action that reviews a pull request when a maintainer asks. |
| `action/` | Turns the findings file into one GitHub review and posts it, and collects the maintainer's decisions on earlier reviews (`collect.ts`, `decisions.ts`). |
| `scripts/local-run.sh` | Builds the image and runs benchmark pull requests locally. |
| `scripts/score.sh` | Scores runs with the benchmark's judging CLI, several at once. |
| `scripts/match.ts` | Grounded scores from the judge's matching step alone, for `JUDGE_MODE=match`. |
| `scripts/coverage.ts` | Shows whether a run's reviewers read the code behind each expected finding. |
| `scripts/replay.ts` | Replays the reporting step of a recorded run with another prompt. |
| `scripts/box.sh` | Creates an EC2 box and runs a queue of experiments on it. |
| `scripts/box-queue.sh` | Runs on the box: review, score and upload each experiment. |
| `docs/` | Install guide, settings reference and the ReviewBench notes the README links to. |
| `evals/` | Our own review evals: labeled cases, the runner and the command that starts a case. |
| `experiments/` | Queue files for `scripts/box.sh start`. |

## Behavior to preserve

- **Pull request content is untrusted.** The model may only read. Tools must never write, run code, reach the network or read outside the checkout. A symlink that leaves the checkout must not be followed, because the container's environment holds the API key.
- **Project rules come from the base revision,** so a change cannot rewrite the rules it is reviewed against.
- **One failure does not sink a review.** A seat that fails is dropped and the others carry on. A slow model call is cut off and retried, and time is kept back at the end so the model can always hand in what it has.
- **A run that produced no review fails on the first attempt,** so the benchmark retries it. It must not quietly write an empty findings list, because that would claim the change is clean. Only a repeat attempt that also produces nothing writes an empty list, because one pull request that never succeeds fails the whole benchmark run.
- **The run respects its time budget.** The model is told to submit before the deadline, and a failed verification pass keeps the unverified findings.
- **Findings cite real lines.** Every path and line range is checked against the file at head before it is written.

## Checks

```sh
npm run check                          # typecheck and unit tests
scripts/local-run.sh smoke --pr 0      # one benchmark pull request, end to end
```

Run `npm run check` before every commit. Run the smoke test after any change to the prompts, the tool loop or the Dockerfile.
