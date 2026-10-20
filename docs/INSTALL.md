# Install the GitHub Action

RevEngine reviews pull requests in your repository when a person with write access comments `/review` on one. The findings come back as one review with comments on the changed lines. Comments from anyone else are ignored, because each review costs money.

## Setup

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
    if: github.event_name == 'workflow_dispatch' || (github.event.issue.pull_request && (startsWith(github.event.comment.body, '/review ') || github.event.comment.body == '/review'))
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: laude-institute/rev-engine-prime@main
        with:
          openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
          pr-number: ${{ inputs.pr-number }}
```

You can also start a review from the Actions tab by running the workflow with a pull request number.

## What you get

By default the action reviews with `anthropic/claude-opus-5.5`, comments on at most 10 findings of medium or high severity, and lists the less severe ones in a collapsed section of the summary. It also gives a short answer to whether the change belongs in the project. The summary opens with one line of merge advice, which plain rules decide from the severities and that answer.

On a later review of the same pull request, the action first collects what the maintainer decided about earlier findings, and the review does not report a decided finding again unless the code shows a fix is missing or the code has changed. A decision counts when someone with write access wrote it: a reply on one of the action's comments that starts with **Fixed**, **Partly fixed**, **Won't fix**, **Deferred** or **Wrong**, a thread they resolved, or a comment that starts with `## Review evaluation` and labels findings as `must`, `valid` or `invalid`. A comment nobody answered is not a decision. The summary says how many findings were left out this way and which earlier ones they repeated. If collecting fails, the run logs a warning and reviews as before.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `model` | `anthropic/claude-opus-5.5` | OpenRouter model that reviews and verifies. |
| `min-severity` | `medium` | The least severe findings that get a comment. One of `high`, `medium` or `low`. |
| `max-findings` | `10` | Cap on findings that get a comment. The rest join the collapsed section. |
| `fit` | `on` | Say whether the change belongs in the project. |
| `time-budget` | `780` | Seconds allowed for the review. |
| `command` | `/review` | A comment starts a review only when it is this text, or this text followed by a space. |
| `allow-forks` | `false` | Set to `true` to review pull requests from forks. |

## Security

The model only reads the pull request's code and never runs it. The review step holds the model key and no GitHub token, and the step that posts the review holds the GitHub token and no model key. Pull requests from forks are skipped unless `allow-forks` is `true`.
