# Swarm prototype

This prototype tests whether many short reviews by a cheap model can do as well as one long review by a strong model. It is an experiment and lives outside `src/`. The container loads it only when `RB_CONFIG_SWARM=on`.

## How it works

1. The diff is cut into chunks. The hunks of one file that sit within 20 lines of each other form a unit, and units are packed in diff order into at most `RB_CONFIG_SWARM_CHUNKS` chunks. Lockfiles and other generated files are skipped.
2. Each chunk's agents start with its hunks, the file around them, and every line in the checkout that mentions a name the chunk defines or changes. The mentions come from one `git grep` over the checkout, so a cheap model spends few turns looking for callers.
3. Each chunk gets one agent for each chunk task, and the whole change gets one agent for each global pass. Every task is a short list of steps, in [`tasks.ts`](tasks.ts). Agents also report what they checked for each step, so the run log shows coverage.
4. The findings are merged in two steps. The word-based merge of the main review folds findings in nearly the same words. Then the model reads each file's findings, up to 40 at a time in line order, and groups the ones that describe the same problem at the same place. A group's findings must sit within 40 lines of each other. Each group keeps its most severe finding, then the most confident, then the most detailed, and the number of agents behind it is kept.
5. Each batch of findings from the same files is checked by `RB_CONFIG_SWARM_VOTES` verifiers, and a finding is dropped when most of them reject it.
6. The survivors are ranked by severity, then by how many agents reported them, then by confidence, and capped at `RB_CONFIG_MAX_FINDINGS`.

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
| `RB_CONFIG_SWARM_MERGE` | `on` | `on` has the model group repeats before verification. `off` uses only the word-based merge. |

With 10 chunks, the default runs 45 reviewing agents, and at most 16 model calls are in flight at once.

## Handling timeouts and failures

- **A stalled call is cut off after 90 seconds** and retried, instead of after the client's usual 3 minutes.
- **A failed agent gets one more try** in a new conversation when at least 3 minutes of review time remain. Both attempts are in the trace.
- **An agent whose turn comes with less than 2 minutes of review time left is skipped**, and so is a verifier with less than 1 minute. The tally counts only the votes cast, and a finding no verifier voted on is kept.
- **A first attempt where fewer than half of the agents finished fails**, so the benchmark retries the pull request. A later attempt keeps what it has, because one pull request that never succeeds fails the whole run.
- **The search for mentions gives up after 30 seconds** on a huge checkout, and the agents search for themselves.
- **The trace is written after each phase**, so a run the benchmark stops still shows what it did.
- **Every log line names its agent**, such as `c2/callers: turn 3 at 41s`.

## Tracing misses

Every run writes `swarm.json` beside the findings file. It holds:

- the chunks, with each unit's hunks, the names found in them and how many mentions each name had
- each agent's tasks, status, error, time, findings submitted and kept, and its list of what it checked
- every proposed finding with the agent that proposed it, the proposal the word-based merge folded it into, the finding the model merge grouped it into, and its final id
- each model merge batch and the groups it made
- each verifier's vote and reason for every finding, the tallied result, and whether the finding survived
- the final list with the proposals behind each finding and how many agents reported it, and the findings the cap cut

Run with `RB_TRANSCRIPT_OUT=/work/out/transcript.json` and `RB_DETAILS_OUT=/work/out/details.json` as well, so every agent's conversation is kept. `context.json` records what each agent read, and `scripts/coverage.ts` counts the verifiers apart from the reviewers because their callers start with `verifier`.

With these files, each expected finding the run missed falls into one of these cases:

- No agent read the code. Check `context.json`, and check which chunk held the lines.
- An agent read it but proposed nothing. Check that agent's checklist and transcript.
- It was proposed and then merged into another finding. Check `mergedInto` and `groupedInto`.
- It was proposed and then voted down. Check the ballots.
- It survived and the cap cut it. Check `cutByCap`.
- It was in the findings file and the judge did not match it.

`node experiments/prototypes/swarm/misses.ts <run>` sorts a scored run's misses into these cases and writes `runs/<run>/misses.md`. Use it only on the 25 pull request test set.
