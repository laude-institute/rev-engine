# Review evals

These cases check the reviewer on pull requests where a person has already said which findings were right. They track what ReviewBench does not score: severity, kind, merge advice, the fit answer and known false positives.

The cases are both regression checks and a score to improve. The same rule applies here as for the benchmark: a change to the reviewer must be general, and never written to make one case pass. While the set is small, read a change in score case by case rather than as one number.

## Collect a case

After the GitHub Action has reviewed a pull request, start a case with one command:

```sh
npm run eval:add -- owner/repo#123
```

The command records the pull request's commits, title and description. It finds the action's latest review, or the one named with `--review <review id>`, and takes the commit that review names as the case's `head`. It downloads the findings the action saved for that review and lists them as `unlabeled`, with their lines and the review's own wording and severity under `found_by`. It also records the review under `reviews` and any commits pushed after it under `fixes`. Add `--head <commit>` to override the reviewed commit, and `--private` for a private repository, which writes the case to `evals/private/`, a folder git ignores.

Then open the case file and label it:

1. Set `source` to where the judgment comes from, such as the author's reply or a second review.
2. Give each finding a `label`.
   - `must`: every review should report it.
   - `valid`: correct when reported, but not required.
   - `invalid`: wrong, and should not be reported.
   - `unlabeled`: nobody has judged it yet. It is ignored when scoring.
3. Record who decided each label in `judged_by`, with a link or a short quote.
4. Give each `must` and `valid` finding a `severity`, the judged one rather than the review's. It is also the expected minimum unless `min_severity` says otherwise.
5. Rewrite `what` in your own words so it describes the problem and not one review's phrasing. The review's wording stays in `found_by`.
6. Add findings the review missed, each with a `found_by` naming where it came from: a person's review comment, a fix commit the review never asked for, another reviewer, a tool, or a bug a person found. Give them lines, so the case can be exported.
7. Optionally add `kind`, `category`, `min_severity` and `fixed_in` to a finding, and `fit` and `advice` to the case, when you have a view on them.

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
    {
      "id": "short-name", "label": "must", "what": "What is wrong and when.",
      "file": "src/a.ts", "start_line": 10, "end_line": 14, "kind": "defect", "severity": "medium",
      "found_by": [
        { "type": "rev-engine-prime", "ref": "<review link>", "producer": "<model>", "severity": "high", "text": "The review's own wording.", "date": "2026-10-20" },
        { "type": "human-review", "ref": "<comment link>", "text": "The comment's wording." }
      ],
      "judged_by": { "type": "maintainer", "ref": "<link to the decision>", "quote": "Yes, fix this.", "date": "2026-10-20" },
      "fixed_in": "<full commit id>",
      "note": "Why it was labeled this way."
    }
  ],
  "reviews": [{ "producer": "rev-engine-prime", "model": "<model>", "ref": "<review link>", "commit": "<full commit id>", "fit": "fits" }],
  "fixes": ["<full commit id>"]
}
```

`found_by` and `judged_by` keep the two questions apart: who reported a problem, and who decided whether it was right. A case built only from this reviewer's findings can only show how often it finds what it already found. Findings from other sources are what let recall mean something, and keeping the source on each one lets a later analysis count them separately.

| Field | Values |
|---|---|
| `found_by[].type` | `rev-engine-prime`, `other-reviewer`, `human-review`, `author-fix`, `tool`, `person` |
| `judged_by.type` | `maintainer`, `author`, `teammate`, `second-review` |
| `severity`, `min_severity` | `high`, `medium`, `low` |
| `category` | ReviewBench's: `correctness`, `security`, `reliability`, `maintainability`, `testing`, `documentation`, `performance`, `api-architecture`, `accessibility`, `other` |

The stored description is what the reviewer reads. Replace the names of people and deployments in it with general words, and change nothing else.

Only label from a person's judgment. A finding that looks right to you but that nobody has confirmed stays `unlabeled`.

## Export to ReviewBench

The cases can be scored with ReviewBench's judging CLI as well, which gives precision, recall and F1 and judges the findings that match no label:

```sh
npm run eval:export -- <name> [--case <id>]... [--run <eval run name>]
```

It writes `runs/reviewbench/<name>/` with a `golden/` folder, a `manifest.json`, and with `--run`, each review round's findings under `candidates/run-N/`. `must` and `valid` findings become true positives and `invalid` ones false positives. A finding without lines, or a `must` or `valid` finding without a severity, is left out and listed. Category comes from `category`, or else from `kind`. Judge one round at a time, from the ReviewBench checkout, with the command the export prints. The CLI merges every file it is given for one pull request, so pointing it at all the rounds at once would score them as one review.

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
