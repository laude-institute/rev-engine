# Settings

The reviewer container reads its settings from environment variables. It needs one credential, `OPENROUTER_API_KEY`, and reaches one host, the one in `RB_MODEL_BASE_URL` (`https://openrouter.ai/api/v1` by default). The `RB_` names come from the [ReviewBench agent contract](https://github.com/review-bench/ReviewBench/blob/main/AGENT_CONTRACT.md).

If you use the GitHub Action, set its inputs instead. They are listed in [INSTALL.md](INSTALL.md).

| Variable | Default | Meaning |
|---|---|---|
| `RB_CONFIG_MODEL` | `openai/gpt-6-luna` | Reviewer model. A comma-separated list runs one independent review per model. A model followed by `@maintainability` or `@tests` reviews for that one thing only, in place of the full review. |
| `RB_CONFIG_VERIFIER` | first reviewer model | Model for the verification pass. |
| `RB_CONFIG_VERIFY` | `lenient` | `lenient` drops rejected findings, `strict` keeps only confirmed ones, `off` skips the pass. |
| `RB_CONFIG_SECOND_LOOK` | `on` | After a reviewer's first submission, ask it to look again for what it missed. |
| `RB_CONFIG_FOLLOW_UP` | none | A model that reviews the change again in a new conversation after the seats finish, told what they found and asked for what they missed. Skipped when little review time is left. |
| `RB_CONFIG_RETRY_EMPTY` | `on` | When every seat proposes nothing, review once more in a new conversation with the first seat's model, so that two independent reviews agree before the change is called clean. It runs at most once and is skipped when little review time is left. |
| `RB_CONFIG_NAIVE` | `off` | `on` replaces the whole review with a baseline: one call to the first model with the pull request's title, description and diff, asking it to report the problems it finds. No tools, project rules, second look or verification. It measures how much the full review adds over the model alone. |
| `RB_CONFIG_MIN_SEVERITY` | `low` | Drop findings less severe than this before verification. One of `high`, `medium` or `low`. |
| `RB_CONFIG_FIT` | none | A model that says whether the change belongs in the project, judged by the goals and design the project states. It runs after the review and is told the findings, writes `fit.json` beside the findings file, and never changes the findings. |
| `RB_CONFIG_EFFORT` | provider default | Reasoning effort, for models that accept one. |
| `RB_CONFIG_MAX_FINDINGS` | `25` | Cap on findings per pull request. |
| `RB_CONFIG_TIME_BUDGET` | `780` | Seconds allowed for the whole run. |
| `RB_CONFIG_MAX_TURNS` | `40` | Model turns allowed per review or verification pass. |

Setting `RB_DETAILS_OUT` to a path makes the container also write the findings there with each one's severity, kind, title and detail as separate fields. The GitHub Action uses it, and the benchmark does not.

Setting `RB_TRANSCRIPT_OUT` to a path makes the container also write every model conversation of the run there, including the code the reviewer read. `scripts/replay.ts` uses it to try prompt changes without a full review. The file holds the reviewed code, so keep it out of git like any other run output.
