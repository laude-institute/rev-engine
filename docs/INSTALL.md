# Install the GitHub Action

RevEngine reviews pull requests in your repository when a person with write access comments `/review` on one. The findings come back as one review with comments on the changed lines. Comments from anyone else are ignored, because each review costs money. The GitHub App bots named in `allowed-bots`, by default `claude[bot]`, may also start one.

Comment `/review agent` instead to get a review for an agent that manages the pull request. It lists every finding in one comment, as described under [Agent reviews](#agent-reviews).

## Setup

The reviewer calls any OpenAI-compatible chat completions API. This setup uses OpenRouter as the example. Add a `MODEL_API_KEY` secret to the repository with the key for that API, then add this workflow on the default branch:

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
      mode:
        description: human or agent
        default: human
permissions:
  contents: read
  pull-requests: write
jobs:
  review:
    if: github.event_name == 'workflow_dispatch' || (github.event.issue.pull_request && startsWith(github.event.comment.body, '/review'))
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: laude-institute/rev-engine@main
        with:
          model-api-key: ${{ secrets.MODEL_API_KEY }}
          model-base-url: https://openrouter.ai/api/v1
          model-extra-body: '{"usage":{"include":true}}'
          model-extra-body-by-model: '{"anthropic/":{"cache_control":{"type":"ephemeral"}}}'
          pr-number: ${{ inputs.pr-number }}
          mode: ${{ inputs.mode || 'human' }}
```

`model-extra-body` holds the fields an endpoint accepts beyond the standard API. With OpenRouter, `usage.include` reports what each call cost, and `"cache_control":{"type":"ephemeral"}` turns on prompt caching for Anthropic models, which decides most of a review's cost. `model-extra-body` goes with every call, including an agent review's swarm, so `cache_control` goes in `model-extra-body-by-model`, which sends it to the `anthropic/` models alone. Leave out the fields your endpoint does not accept.

You can also start a review from the Actions tab by running the workflow with a pull request number. A workflow without the `mode` lines still runs agent reviews from comments.

## What you get

By default the action reviews with `anthropic/claude-opus-5.5`, comments on at most 10 findings of medium or high severity, and lists the less severe ones in a collapsed section of the summary. It also gives a short answer to whether the change belongs in the project. The summary opens with one line of merge advice, which plain rules decide from the severities and that answer.

On a later review of the same pull request, the action first collects what the maintainer decided about earlier findings, and the review does not report a decided finding again unless the code gives a reason. A finding marked fixed, or a thread resolved without a reply, comes back only when the code at head shows the problem is still there. A finding marked wrong, won't fix or deferred comes back only when the code has changed in a way that makes it right. A finding that comes back names the earlier one it repeats. A decision counts when someone with write access wrote it: a reply on one of the action's comments that starts with **Fixed**, **Partly fixed**, **Won't fix**, **Deferred** or **Wrong**, a thread they resolved, or a comment that starts with `## Review evaluation` and labels findings as `must`, `valid` or `invalid`. A comment nobody answered is not a decision. The fit check also gets the maintainer's answer from the "Fit and recommendation" section of each review evaluation, so it does not raise a concern again that the maintainer already answered, and it keeps the maintainer's latest verdict unless the change has moved since. The summary says how many findings were left out this way and which earlier ones they repeated. If collecting fails, the run logs a warning and reviews as before. Separately, when an earlier comment from the action is still open and raises the same problem on the same lines in nearly the same words, the action does not comment again; it lists the finding in a collapsed part of the summary, with a link to that comment. A different problem on those lines gets its own comment.

## Agent reviews

`/review agent` runs a swarm of short reviews by a cheap model. The review itself usually takes about a minute and costs under $1. Each part of the diff gets agents with one task each, such as checking callers or tests, and three verifiers vote on every finding.

The result is one comment with no comments on lines:

- Every finding the verifiers did not reject, up to 80, most severe first.
- Each finding's severity, how many verifiers confirmed it, its location and the full explanation.
- The same one line of merge advice as a human review.

An agent can read the whole list and decide what to fix. There is no assessment of whether the change belongs in the project, and the `model`, `min-severity`, `max-findings`, `fit` and `time-budget` inputs do not apply.

`/review human`, or `/review` alone, runs the default review.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `model-api-key` | none | Key for the model API at `model-base-url`. Pass it from a repository secret. |
| `model-base-url` | none | The OpenAI-compatible API the reviewer calls, such as `https://openrouter.ai/api/v1`. Required with `model-api-key`. |
| `model-api` | `chat` | API protocol, `chat`, `responses` or `auto`. `auto` selects Responses for `api.openai.com` and its subdomains and chat elsewhere, without changing the configured endpoint. For other Responses-compatible hosts, select `responses` explicitly. |
| `model-extra-body` | none | A JSON object merged into every model request, such as `{"usage":{"include":true}}` for OpenRouter's cost reporting. |
| `model-extra-body-by-model` | none | A JSON object mapping a model name prefix to fields merged into that model's requests only, such as `{"anthropic/":{"cache_control":{"type":"ephemeral"}}}`. |
| `openrouter-api-key` | none | The older way to pass the key, for OpenRouter only. It implies `model-base-url` `https://openrouter.ai/api/v1`, its cost reporting and prompt caching for Anthropic models. Use `model-api-key` and `model-base-url` instead. The legacy input rejects a non-OpenRouter URL. |
| `model` | `anthropic/claude-opus-5.5` | Model that reviews and verifies, as the endpoint at `model-base-url` names it. |
| `min-severity` | `medium` | The least severe findings that get a comment. One of `high`, `medium` or `low`. |
| `max-findings` | `10` | Cap on findings that get a comment. The rest join the collapsed section. |
| `fit` | `on` | Say whether the change belongs in the project. |
| `time-budget` | `780` | Seconds allowed for the review. |
| `command` | `/review` | A comment starts a review only when it is this text, or this text followed by a space. The word after it, `agent` or `human`, picks the review. |
| `mode` | `human` | The review to run when the comment names none, or when the workflow is started by hand. |
| `agent-model` | `deepseek/deepseek-v4.1-flash-1017` | Model the swarm of an agent review uses. Its default is tuned on OpenRouter. |
| `agent-providers` | `together` | OpenRouter providers allowed to serve an agent review's swarm, comma-separated. Leave it empty for an endpoint other than OpenRouter, which does not take this routing. |
| `allow-forks` | `false` | Set to `true` to review pull requests from forks. |
| `allowed-bots` | `claude[bot]` | GitHub App bots, comma-separated, that may start a review without write access, because the collaborator API reports `none` for an app. Set it to an empty string to allow no bots. |

## Security

The model only reads the pull request's code and never runs it. The review step holds the model key and no GitHub token, and the step that posts the review holds the GitHub token and no model key. Pull requests from forks are skipped unless `allow-forks` is `true`.
