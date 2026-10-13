# Review evals

These cases check the reviewer on pull requests where a person has already said which findings were right. They track what ReviewBench does not score: severity, kind, merge advice, the fit answer and known false positives.

The set is small, so read it as a list of regression checks and not as a score. The same rule applies here as for the benchmark: a change to the reviewer must be general, and never written to make one case pass.

## Collect a case

After the GitHub Action has reviewed a pull request, start a case with one command:

```sh
npm run eval:add -- owner/repo#123
```

The command records the pull request's commits, title and description. It also downloads the findings the action saved for its latest review and lists them as `unlabeled`. Add `--head <commit>` when the pull request has changed since the review, and `--private` for a private repository, which writes the case to `evals/private/`, a folder git ignores.

Then open the case file and label it:

1. Set `source` to where the judgment comes from, such as the author's reply or a second review.
2. Give each finding a `label`.
   - `must`: every review should report it.
   - `valid`: correct when reported, but not required.
   - `invalid`: wrong, and should not be reported.
   - `unlabeled`: nobody has judged it yet. It is ignored when scoring.
3. Rewrite `what` in your own words so it describes the problem and not one review's phrasing. Add findings the review missed.
4. Optionally add `kind` and `min_severity` to a finding, and `fit` and `advice` to the case, when you have a view on them.

A case file looks like this:

```json
{
  "id": "repo-123",
  "repo": "owner/repo",
  "pr": 123,
  "base": "<full commit id>",
  "head": "<full commit id>",
  "title": "...",
  "body": "...",
  "source": "The author's reply to the first review.",
  "fit": "fits",
  "advice": ["fix, then merge"],
  "findings": [
    { "id": "short-name", "label": "must", "what": "What is wrong and when.", "file": "src/a.ts", "kind": "defect", "min_severity": "medium", "note": "Why it was labeled this way." }
  ]
}
```

The stored description is what the reviewer reads. Replace the names of people and deployments in it with general words, and change nothing else.

Only label from a person's judgment. A finding that looks right to you but that nobody has confirmed stays `unlabeled`.

## Run the evals

```sh
npm run eval -- <run-name>                     # every case, three reviews each
npm run eval -- <run-name> --runs 1 --case headlong-167
npm run eval -- <run-name> --score-only        # score again without reviewing
```

Each case is reviewed several times because the same model gives different reviews from run to run. The report says how often each labeled finding was reported, such as 2 of 3, and how often its kind and severity were as expected.

A review with the default model costs about $0.65, so three runs of ten cases cost about $20. A second, cheaper model decides which reported finding matches which labeled one. Reviews and the report land in `runs/evals/<run-name>/`, which git ignores. Nothing is posted to GitHub.

The report also lists reported findings that match no label. The ones that recur across runs are the next findings to label.

You need Docker, Node 24, `git`, the `gh` command for `eval:add`, and `OPENROUTER_API_KEY` in the environment or in `.env`.
