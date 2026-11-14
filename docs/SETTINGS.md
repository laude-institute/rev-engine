# Settings

The reviewer container reads its settings from environment variables. It needs one credential, `OPENROUTER_API_KEY`, and reaches one host, the one in `RB_MODEL_BASE_URL` (`https://openrouter.ai/api/v1` by default). [The Claude Code engine](#the-claude-code-engine) uses another credential and host. The `RB_` names come from the [ReviewBench agent contract](https://github.com/review-bench/ReviewBench/blob/main/AGENT_CONTRACT.md).

To call OpenAI directly, set `RB_MODEL_BASE_URL=https://api.openai.com/v1` and put the OpenAI key in `OPENROUTER_API_KEY`. You must also set `RB_CONFIG_MODEL` to an OpenAI model ID without the `openai/` prefix; the default is an OpenRouter ID and will not work here. Any explicitly configured verifier, follow-up, fit, or fixes model must also use an OpenAI model ID.

Requests then go through OpenAI's Responses API. Token usage is recorded, but `usage.cost_usd` is `null` and cost summaries say `unknown` because this API does not report billed cost. OpenRouter remains the default; benchmark runs must allow the configured endpoint.

If you use the GitHub Action, set its inputs instead. They are listed in [INSTALL.md](INSTALL.md).

| Variable | Default | Meaning |
|---|---|---|
| `RB_CONFIG_ENGINE` | `api` | `claude-code` runs each review, verification and fit pass with `claude -p` instead of the chat API. See [The Claude Code engine](#the-claude-code-engine). |
| `RB_CONFIG_FALLBACK` | `off` | With `claude-code`, a model on an OpenAI-compatible endpoint (Command Code by default) that takes over when claude fails. See [The Claude Code engine](#the-claude-code-engine). |
| `RB_CONFIG_MODEL` | `openai/gpt-6-luna` | Reviewer model. A comma-separated list runs one independent review per model. A model followed by `@maintainability` or `@tests` reviews for that one thing only, in place of the full review. |
| `RB_CONFIG_VERIFIER` | first reviewer model | Model for the verification pass. |
| `RB_CONFIG_VERIFY` | `lenient` | `lenient` drops rejected findings, `strict` keeps only confirmed ones, `off` skips the pass. |
| `RB_CONFIG_SECOND_LOOK` | `on` | What a reviewer does after its first submission. `on` asks it to look again for what it missed. `sweep` has it go through the changed hunks in up to six rounds, and `sweep-low` does the same while asking for small problems too. `small` looks again once and then makes one pass only for small problems, such as stale docs, naming and missing tests. `off` skips it. The modes other than `on` and `off` are being tried and may be removed. |
| `RB_CONFIG_FOLLOW_UP` | none | A model that reviews the change again in a new conversation after the seats finish, told what they found and asked for what they missed. Skipped when little review time is left. |
| `RB_CONFIG_RETRY_EMPTY` | `on` | When every seat proposes nothing, review once more in a new conversation with the first seat's model, so that two independent reviews agree before the change is called clean. It runs at most once and is skipped when little review time is left. |
| `RB_CONFIG_NAIVE` | `off` | `on` replaces the whole review with a baseline: one call to the first model with the pull request's title, description and diff, asking it to report the problems it finds. No tools, project rules, second look or verification. It measures how much the full review adds over the model alone. |
| `RB_CONFIG_SWARM` | `off` | `on` replaces the review with a prototype that runs many short reviews by a cheap model, one for each chunk of the diff and task, and has several verifiers vote on the findings. It is an experiment and may be removed. Its own settings are described in [`experiments/prototypes/swarm/README.md`](../experiments/prototypes/swarm/README.md). |
| `RB_CONFIG_MIN_SEVERITY` | `low` | Drop findings less severe than this before verification. One of `high`, `medium` or `low`. |
| `RB_CONFIG_FIT` | none | A model that says whether the change belongs in the project, judged by the goals and design the project states. It runs after the review and is told the findings, writes `fit.json` beside the findings file, and never changes the findings. |
| `RB_CONFIG_FIXES` | none | A model that writes a fix for each final finding whose remedy is a small change to the lines it names: at most 10 lines replaced, on or next to the finding's lines. It runs after the review, reserves time for a configured fit assessment, and never changes the findings. It does not edit the checkout or post GitHub suggestions. A fix is written to the details file as the finding's `fix`, with `start_line`, `end_line` and `replacement`. Most findings get none. |
| `RB_CONFIG_EFFORT` | provider default | Reasoning effort, for models that accept one. |
| `RB_CONFIG_MODE` | `human` | Who reads the review. `agent` writes a thorough review for an agent that manages the pull request: the cap defaults to 80, and with `RB_CONFIG_SWARM=on` each message starts with the finding's severity and how many verifiers confirmed it, and every swarm agent runs twice. `human` writes a shorter review for people to read. The benchmark runs `agent`. |
| `RB_CONFIG_MAX_FINDINGS` | `25`, or `80` in agent mode | Cap on findings per pull request. |
| `RB_CONFIG_TIME_BUDGET` | `780` | Seconds allowed for the whole run. |
| `RB_CONFIG_MAX_TURNS` | `40` | Model turns allowed per review or verification pass. |

Setting `RB_DETAILS_OUT` to a path makes the container also write the findings there with each one's severity, kind, title and detail as separate fields. The GitHub Action uses it, and the benchmark does not.

`RB_PRIOR_JSON` names a file of the maintainer's decisions on earlier reviews of the same pull request (default `/work/pr/prior.json`). When it exists, the reviewer is told not to report decided findings again, and the verifier marks any finding that repeats one. A repeat is left out unless the verifier finds, from the code, that the fix is missing or that the code changed in a way that makes the finding right. Those left out are listed under `decided` in the details file. The file can also hold the maintainer's fit answers from review evaluations, which go to the fit check. Without the file the review is unchanged, which is the case for every benchmark run. The GitHub Action writes the file with `action/collect.ts`.

Setting `RB_TRANSCRIPT_OUT` to a path makes the container also write every model conversation of the run there, including the code the reviewer read. `scripts/replay.ts` uses it to try prompt changes without a full review. The file holds the reviewed code, so keep it out of git like any other run output. With the Claude Code engine the conversations are rebuilt from Claude Code's output in the same format, without the model's reasoning.

Setting `RB_CONTEXT_OUT` to a path makes the container write what each model read: every file and line range, every diff slice and every search with the lines it hit. It holds paths and line numbers only, no code. `scripts/local-run.sh` always sets it, and `scripts/coverage.ts` uses it to show whether the reviewer read the code behind each expected finding.

## The Claude Code engine

`RB_CONFIG_ENGINE=claude-code` runs each review, verification and fit pass with Claude Code (`claude -p`) instead of the chat API. Claude Code gets none of its own tools. It reads the checkout only through the reviewer's read tools. The naive baseline is one `claude` run with no tools at all.

- **Image.** Claude Code is left out of the image by default. Name an exact version at build time to include it: `docker build --build-arg CLAUDE_CODE_VERSION=2.1.321 .`
- **Credential and host.** Claude Code signs in with `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY`, in place of `OPENROUTER_API_KEY`. With neither set, it uses the claude CLI's own login, which is how [the local runner](LOCAL.md) reviews as whoever ran `claude auth login`. The reviewer checks that login with `claude auth status` before it starts. On macOS the login is kept in the keychain, so a locked keychain reads as signed out. A container has no CLI login unless one is mounted, so give it a token. It reaches Anthropic's API in place of `RB_MODEL_BASE_URL`. Nonessential traffic, including telemetry and automatic updates, is disabled.
- **Fallback.** `RB_CONFIG_FALLBACK=<model>` names a model on an OpenAI-compatible chat completions endpoint that takes over when claude fails. A pass claude cannot finish starts over there with the time and turns claude did not use, and when claude cannot run at all, such as when it is not signed in, every pass runs there. The endpoint is `RB_FALLBACK_BASE_URL`, by default Command Code's provider API, `https://api.commandcode.ai/provider/v1`, and its key is `CMD_API_KEY`. The fallback is not started, and claude's error stands, when fewer than 2 turns are left, or less time than the larger of the pass's wrap-up time and 10 seconds; a direct call, such as the naive baseline's, needs 10 seconds. The fallback ignores `RB_CONFIG_EFFORT`, whose levels are Claude's. A run with a fallback also reaches that host.
- **Models.** `RB_CONFIG_MODEL` must be set. Every model must be a Claude model, such as `anthropic/claude-opus-5.5` or `opus`.
- **Effort.** `RB_CONFIG_EFFORT` is one of `low`, `medium`, `high`, `xhigh` or `max`.
- **Usage.** The reported cost is what the tokens cost at API prices. A subscription login is not charged that amount. If a call stops before reporting its totals, observed token usage is retained and cost is `null` (unknown).
- **Not supported.** The swarm review.
