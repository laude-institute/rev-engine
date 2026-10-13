# rev-engine-prime

A pull request reviewer packaged as a container for [ReviewBench](https://github.com/review-bench/ReviewBench), an open benchmark for AI code review.

This is early work. It has not been registered with the benchmark and has no published score.

## How it reviews

1. **Independent review.** One or more models each review the change on their own. A model can only read: the diff, files at the head and base revisions, file listings and text search, all confined to the checkout. The reviewer is asked to understand the system before judging the change, then to check it against a fixed set of lenses: fit with the design, unexpected additions, correctness, production safety, security, data exposure, performance, compatibility, tests, and documentation. After its first submission it is asked to look once more.
2. **Verification.** A second pass checks every proposed finding against the code, rejects the ones that do not hold, and marks repeats.
3. **Reduction.** Plain code checks each path and line range against the file at head, merges duplicates, ranks by severity and confidence, and caps the list.

The pull request's text and code are treated as untrusted input throughout. The project's own instruction files, such as `AGENTS.md` and `CONTRIBUTING.md`, are read from the base revision and given to the reviewer as the rules the change should follow.

## Settings

The container follows the benchmark's [agent contract](https://github.com/review-bench/ReviewBench/blob/main/AGENT_CONTRACT.md). It needs one credential, `OPENROUTER_API_KEY`, and reaches one host, the one in `RB_MODEL_BASE_URL` (`https://openrouter.ai/api/v1` by default).

| Variable | Default | Meaning |
|---|---|---|
| `RB_CONFIG_MODEL` | `openai/gpt-6-luna` | Reviewer model. A comma-separated list runs one independent review per model. A model followed by `@maintainability` or `@tests` reviews for that one thing only, in place of the full review. |
| `RB_CONFIG_VERIFIER` | first reviewer model | Model for the verification pass. |
| `RB_CONFIG_VERIFY` | `lenient` | `lenient` drops rejected findings, `strict` keeps only confirmed ones, `off` skips the pass. |
| `RB_CONFIG_SECOND_LOOK` | `on` | After a reviewer's first submission, ask it to look again for what it missed. |
| `RB_CONFIG_FOLLOW_UP` | none | A model that reviews the change again in a new conversation after the seats finish, told what they found and asked for what they missed. Skipped when little review time is left. |
| `RB_CONFIG_MIN_SEVERITY` | `low` | Drop findings less severe than this before verification. One of `high`, `medium` or `low`. |
| `RB_CONFIG_FIT` | none | A model that says whether the change belongs in the project, judged by the goals and design the project states. It runs after the review and is told the findings, writes `fit.json` beside the findings file, and never changes the findings. |
| `RB_CONFIG_EFFORT` | provider default | Reasoning effort, for models that accept one. |
| `RB_CONFIG_MAX_FINDINGS` | `25` | Cap on findings per pull request. |
| `RB_CONFIG_TIME_BUDGET` | `780` | Seconds allowed for the whole run. |
| `RB_CONFIG_MAX_TURNS` | `40` | Model turns allowed per review or verification pass. |

Setting `RB_DETAILS_OUT` to a path makes the container also write the findings there with each one's severity, kind, title and detail as separate fields. The GitHub Action uses it; the benchmark does not.

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

## Use it as a GitHub Action

The same reviewer can review pull requests in your own repository. A person with write access starts a review by commenting `/review` on a pull request, and the findings come back as one review with comments on the changed lines. Comments from anyone else are ignored, because each review costs money.

Add an `OPENROUTER_API_KEY` secret to the repository, then add this workflow on the default branch:

```yaml
name: Review
on:
  issue_comment:
    types: [created]
  workflow_dispatch:
    inputs:
      pr-number:
        description: Pull request number
        required: true
permissions:
  contents: read
  pull-requests: write
jobs:
  review:
    if: github.event_name == 'workflow_dispatch' || (github.event.issue.pull_request && startsWith(github.event.comment.body, '/review'))
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: laude-institute/rev-engine-prime@main
        with:
          openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
          pr-number: ${{ inputs.pr-number }}
```

By default the action reviews with `anthropic/claude-opus-5.5`, comments on at most 10 findings of medium or high severity, lists the less severe ones in a collapsed section of the summary, and adds a short answer to whether the change belongs in the project. The summary opens with one line of merge advice, decided by plain rules from the severities and that answer. The inputs `model`, `min-severity`, `max-findings`, `fit` and `time-budget` change those. Pull requests from forks are skipped unless `allow-forks` is `true`.

The model only reads the pull request's code and never runs it. The review step holds the model key and no GitHub token, and the step that posts the review holds the GitHub token and no model key.

## License

Apache 2.0. See [LICENSE](LICENSE).
