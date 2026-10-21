# Swarm prototype

This prototype tests whether many short reviews by a cheap model can do as well as one long review by a strong model. It is an experiment and lives outside `src/`. The container loads it only when `RB_CONFIG_SWARM=on`.

## How it works

1. The diff is cut into chunks. The hunks of one file that sit within 20 lines of each other form a unit, and units are packed in diff order into at most `RB_CONFIG_SWARM_CHUNKS` chunks. Lockfiles and other generated files are skipped.
2. Each chunk's agents start with its hunks, the file around them, and every line in the checkout that mentions a name the chunk defines or changes. The mentions come from one `git grep` over the checkout, so a cheap model spends few turns looking for callers.
3. Each chunk gets one agent for each chunk task, and the whole change gets one agent for each global pass. Every task is a short list of steps, in [`tasks.ts`](tasks.ts). Agents also report what they checked for each step, so the run log shows coverage.
4. The word-based merge of the main review folds findings in nearly the same words.
5. Each batch of findings from the same files is checked by `RB_CONFIG_SWARM_VOTES` verifiers, and a finding is dropped when most of them reject it.
6. When more findings survive than `RB_CONFIG_MAX_FINDINGS`, the model folds repeats among them. It reads each file's findings, up to 40 at a time in line order, and groups the ones that describe the same problem at the same place. It answers in one call and is offered no read tools, because it decides from the findings alone. A group's findings must sit within 40 lines of each other. Each group keeps its most severe finding, then the most confident, then the most detailed, and the number of agents behind it is kept. The merge comes after verification so that every finding is judged on its own votes, and a review under the cap keeps every finding it found.
7. The survivors are ranked by severity, then by how many agents reported them, then by confidence, and capped at `RB_CONFIG_MAX_FINDINGS`. With `RB_CONFIG_MODE=agent`, each message starts with the finding's severity and how many verifiers confirmed it, such as `[medium severity, confirmed by 2 of 3 checks]`.

The tasks are:

| Task | Runs | What it checks |
|---|---|---|
| `callers` | per chunk | Every use of what the chunk changed: arguments, new return values and errors, old names still in use, other implementations |
| `callees` | per chunk | Every call the chunk makes: arguments, ignored errors, missing awaits, nulls, side effects, cleanup |
| `logic` | per chunk | Conditions, bounds, copy and paste mistakes, branches that disagree, edge inputs, races |
| `fit` | per chunk | Departures from neighboring patterns, duplicated helpers, dead code, constants, stale comments |
| `tests` | global | Tests that cannot fail or check too little, and behaviors with no test |
| `promise` | global | Claims in the description that the code does not deliver, and additions it does not mention |
| `together` | global | Siblings that had to change too: other implementations, switch statements, schemas, registration |
| `docs` | global | Documentation, examples and messages the change made wrong |
| `risk` | global | Security, data exposure, deployment and failure handling, performance |
| `types` | each chunk, on trial | Every way out of a changed function returns the same type and shape, and annotations say so |
| `compat` | global, on trial | New syntax and library calls against the oldest versions the project declares |
| `claims` | global, on trial | Changelogs, docs, comments and messages the change edits match what its code does |

The tasks on trial run only when `RB_CONFIG_SWARM_TASKS` names them.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `RB_CONFIG_SWARM` | `off` | `on` runs the swarm instead of the usual review. |
| `RB_CONFIG_MODEL` | | The first model runs every agent. |
| `RB_CONFIG_VERIFIER` | the model | The model that votes on findings. |
| `RB_CONFIG_SWARM_SPLIT` | `task` | `task` runs one agent for each chunk and task. `chunk` runs one agent for each chunk, with every chunk task as one longer checklist. |
| `RB_CONFIG_SWARM_CHUNKS` | `10` | The most chunks to cut the diff into, from 1 to 40. |
| `RB_CONFIG_SWARM_VOTES` | `3` | Verifiers for each batch of findings, from 0 to 5. `0` skips verification, and so does `RB_CONFIG_VERIFY=off`. |
| `RB_CONFIG_SWARM_TASKS` | all | A comma-separated subset of the task names, for leaving tasks out. |
| `RB_CONFIG_SWARM_MERGE` | `on` | `on` has the model group repeats after verification when more findings are left than the cap. `off` uses only the word-based merge. |
| `RB_CONFIG_SWARM_TARGET` | `0` | Seconds the whole review should take, from 30 to 780. `0` fills the benchmark's time budget. Any other value turns on the fast pace described below. |
| `RB_CONFIG_SWARM_SORT` | unset | `latency` or `throughput` asks OpenRouter to route every call to the provider that is best by that measure. |
| `RB_CONFIG_SWARM_EFFORT` | unset | The reasoning effort for the swarm's calls: `none`, `minimal`, `low`, `medium` or `high`. Unset uses `RB_CONFIG_EFFORT`. A call that reasons at length is slow, so a lower effort may speed up a fast review. |
| `RB_CONFIG_SWARM_REASONING_TOKENS` | unset | The most tokens one swarm call may reason for, from 100 to 32000. It takes the place of the effort. DeepSeek V4.1 Flash reasons at about 100 tokens a second and treats `low` effort as a suggestion, so a cap is the dependable way to bound a call's time. |
| `RB_CONFIG_SWARM_CONTEXT` | `basic` | `rich` also gives each chunk's agents the code around every use of a name the chunk changes, the first lines of the functions it calls, the tests whose file names match the changed files, and the code at the base revision. Each part has a line limit. Built in [`context.ts`](context.ts). |
| `RB_CONFIG_SWARM_LIMIT` | the target | Seconds after which a fast review is cut off, when it should be later than the target. Agents are still told the target and slow calls are still resent at the target's pace, but no call or phase is cut off before its share of the limit. |
| `RB_CONFIG_SWARM_PROVIDERS` | any | A comma-separated list of OpenRouter providers allowed to serve the swarm's calls, such as `together,fireworks,deepinfra/fp8`. No other provider is tried. OpenRouter serves one model through many providers, some at lower precision, and runs have scored differently by which ones served them. |
| `RB_CONFIG_SWARM_EVIDENCE` | `on` | With rich context and a target, `on` also shows each verifier where the names a finding mentions are defined or used elsewhere. `off` shows only the code around each finding. |

With 10 chunks, the default runs 45 reviewing agents, and at most 16 model calls are in flight at once.

## Handling timeouts and failures

- **A stalled call is cut off after 90 seconds** and retried, instead of after the client's usual 3 minutes.
- **A failed agent gets one more try** in a new conversation when at least 3 minutes of review time remain. Both attempts are in the trace.
- **An agent whose turn comes with less than 2 minutes of review time left is skipped**, and so is a verifier with less than 1 minute. The tally counts only the votes cast, and a finding no verifier voted on is kept.
- **A first attempt where fewer than half of the agents finished fails**, so the benchmark retries the pull request. A later attempt keeps what it has, because one pull request that never succeeds fails the whole run.
- **The search for mentions gives up after 30 seconds** on a huge checkout, and the agents search for themselves.
- **The trace is written after each phase**, so a run the benchmark stops still shows what it did.
- **Every log line names its agent**, such as `c2/callers: turn 3 at 41s`.

## The fast pace

Most of a normal swarm review is spent waiting. Each agent takes 10 to 40 turns one after another, the turn that writes the findings is the slowest, and a few calls stall until they time out. The review ends only when its slowest agent does. With `RB_CONFIG_SWARM_TARGET` set, the swarm changes the following to finish near the target:

- **Every agent starts at once** and has 65% of the target to review, in at most 6 turns.
- **An agent is asked to submit first**, from the code and mentions in its prompt, before it reads any file, so an agent that is cut off later still has its findings. The first turn is not forced to be a submission, because a forced submission comes back as an empty placeholder. While time remains, it gets up to three more rounds to read code and submit new findings, which are added to the first.
- **Agents are asked for at most 6 findings** with short details, and do not list what they checked, because the submission turn grows with what the model writes.
- **A call may run for the whole review window**, because an agent's first answer is one long call. A call still running after 40% of the target is sent again, or after a sixth of it when reasoning is off (`RB_CONFIG_SWARM_EFFORT=none`), because such a call answers in seconds unless it has stalled. The first answer is used. Both calls are paid for, and the trace counts how many were sent again.
- **A failed agent is not run again on its own**, because there is no time for it. When more than half of the agents fail or hand in no findings, those agents run again at the normal pace, so the review misses its target on that pull request instead of failing or handing in a mostly blind review.
- **Verifiers decide in one turn** from the diff and the 15 lines above and below each finding, instead of reading files. With `RB_CONFIG_SWARM_CONTEXT=rich` and `RB_CONFIG_SWARM_EVIDENCE=on` they are also shown where the names each finding mentions are defined or used elsewhere, so a claim about what a constant holds or a function does can be checked.
- **The merge, when it runs, gets up to 15% of the target** from what verification leaves, and is skipped when less than half of that is left.

## Tracing misses

Every run writes `swarm.json` beside the findings file. It holds:

- the chunks, with each unit's hunks, the names found in them and how many mentions each name had
- each agent's tasks, status, error, time, findings submitted and kept, and its list of what it checked
- every proposed finding with the agent that proposed it, the proposal the word-based merge folded it into, the finding the model merge grouped it into, and its final id
- each model merge batch and the groups it made
- each verifier's vote and reason for every finding, the tallied result, and whether the finding survived
- the final list with the proposals behind each finding and how many agents reported it, and the findings the cap cut
- every model call, with its caller, when it started, how long it took, whether it succeeded, and how much it reasoned and wrote, and the time each phase took

Run with `RB_TRANSCRIPT_OUT=/work/out/transcript.json` and `RB_DETAILS_OUT=/work/out/details.json` as well, so every agent's conversation is kept. `context.json` records what each agent read, and `scripts/coverage.ts` counts the verifiers apart from the reviewers because their callers start with `verifier`.

With these files, each expected finding the run missed falls into one of these cases:

- No agent read the code. Check `context.json`, and check which chunk held the lines.
- An agent read it but proposed nothing. Check that agent's checklist and transcript.
- It was proposed and then merged into another finding. Check `mergedInto` and `groupedInto`.
- It was proposed and then voted down. Check the ballots.
- It survived and the cap cut it. Check `cutByCap`.
- It was in the findings file and the judge did not match it.

`node experiments/prototypes/swarm/misses.ts <run> [scoring-name...]` sorts a scored run's misses into these cases and writes `runs/<run>/misses.md` and `misses.json`. It works out what each agent had in its prompt from `transcript.json`, so code shown through rich context counts as read. The judge's matching varies from pass to pass, so a run can be matched twice (`SCORING_NAME=matching2 JUDGE_MODE=match scripts/score.sh <run>`) and both names given; the report then says which misses every matching agreed on.

`node experiments/prototypes/swarm/false-positives.ts <run> [scoring-name...]` lists every reported finding the judge matched only to expected findings marked wrong, with the agents and tasks that proposed it, the verifiers' votes and reasons, and the benchmark's reason the claim is wrong. It writes `runs/<run>/false-positives.md` and `false-positives.json`.

Use both only on the 25 pull request test set.

`node experiments/prototypes/swarm/replay-merge.ts <run> <new-run>` runs the merge again on a recorded run's proposals and rebuilds its findings from the recorded votes, so a change to the merge can be scored with `JUDGE_MODE=match scripts/score.sh <new-run>` without reviewing again. With `--original` it reuses the recorded groups, which should reproduce the recorded findings exactly.
