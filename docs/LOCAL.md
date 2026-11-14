# Run it locally

`scripts/local.ts` is an optional way to run the reviewer without Docker or
ReviewBench. It prepares a committed checkout and calls the same `src/main.ts`
used by the container. The GitHub Action and benchmark workflows are unchanged.

```sh
node scripts/local.ts branch --base main     # the current branch, before a pull request
node scripts/local.ts pr 1938                # a pull request at its head
node scripts/local.ts doctor                 # node, git, gh, settings and the key
```

Both review modes need Node 24 or newer, Git and `OPENROUTER_API_KEY`. PR mode
also needs an authenticated `gh` installation. Export the key in your shell,
or load your trusted credentials file explicitly with Node:

```sh
node --env-file=/path/to/reviewer/.env scripts/local.ts branch --base main
```

The runner never loads a credentials file from the repository being reviewed.
Doctor exits nonzero when Node, Git or the key is missing. It reports `gh`
separately because branch mode does not need it.

## Modes

| Mode | Reviews | Tree |
|---|---|---|
| `branch` | `git diff <merge-base(base, HEAD)>..HEAD` | a detached checkout of the captured HEAD |
| `pr <number>` | the PR head and base commits returned by `gh` | a detached checkout of the PR head |

Both modes leave your working copy unchanged. They review committed files in a
new worktree under the system temporary directory, so ignored local files and
later edits in your working copy are not visible to the reviewer. Branch mode
refuses a dirty tree so you do not mistake a review of HEAD for a review of
uncommitted work. Git checkout hooks are disabled when creating the worktree.

`RB_BASE` is the merge base. Branch mode uses `--base`, or a locally available
default branch; fetch first when you want the latest remote base. PR mode uses
the exact base commit from GitHub, unless you override it with `--base`. It
fetches missing PR commits. PR mode honors `gh`'s configured default repository,
including upstream in a fork clone, and fetches from the repository named by the returned PR URL. Branch
mode uses `origin`, or the first remote when there is no `origin`, for its
default remote branch.

The worktree is removed after completion, failure, SIGINT or SIGTERM unless
`--keep` is given. With `--keep`, its path is printed to stderr. A forced kill
such as SIGKILL cannot run cleanup. `--dry-run` also removes its worktree unless
combined with `--keep`.

## Settings

Every setting flag sets the container variable of the same name, so
`--min-severity high` is `RB_CONFIG_MIN_SEVERITY=high`. `--set KEY=VALUE` covers
other settings in [SETTINGS.md](SETTINGS.md).

| Flag | Setting |
|---|---|
| `--model` | `RB_CONFIG_MODEL` |
| `--verifier` | `RB_CONFIG_VERIFIER` |
| `--verify` | `RB_CONFIG_VERIFY` |
| `--second-look` | `RB_CONFIG_SECOND_LOOK` |
| `--follow-up` | `RB_CONFIG_FOLLOW_UP` |
| `--retry-empty` | `RB_CONFIG_RETRY_EMPTY` |
| `--mode` | `RB_CONFIG_MODE` |
| `--min-severity` | `RB_CONFIG_MIN_SEVERITY` |
| `--max-findings` | `RB_CONFIG_MAX_FINDINGS` |
| `--time-budget` | `RB_CONFIG_TIME_BUDGET` |
| `--max-turns` | `RB_CONFIG_MAX_TURNS` |
| `--effort` | `RB_CONFIG_EFFORT` |
| `--fit` | `RB_CONFIG_FIT` |

Settings come from the runner's own `src/config.ts` and the optional swarm
module, which belong to the reviewer it executes, rather than the repository
being reviewed. Unknown settings are refused so they cannot be silently ignored. New settings read in
the same form by that config file can be passed through `--set`.

Exported `RB_CONFIG_*` settings are included and validated, with command-line
values taking precedence. The effective overrides appear in the run metadata
and `--dry-run` output. Unset settings use the reviewer's defaults. An exported
`RB_MODEL_BASE_URL` is also preserved and reported. Other inherited `RB_*`
variables are removed; the runner controls the input and output paths and
always starts at attempt 1.

Other flags:

- `--repo <path>` selects the checkout, defaulting to `.`.
- `--base <ref>` overrides the base used for the merge-base calculation.
- `--prior <file>` copies a JSON file of earlier review decisions into the run.
  The default is `none`; there is no automatic GitHub decision collection.
- `--pr-number <number>` sets the metadata number for branch mode, defaulting
  to 1. PR mode uses its positional number.
- `--json` prints machine-readable findings, decisions and any fit assessment.
- `--fail-on high|medium|low` exits 2 on findings at or above that severity.
- `--quiet` suppresses the reviewer's progress on stderr.
- `--dry-run` prints the prepared environment without calling a model.
- `--keep` retains the detached review checkout in either mode.

## Output

Each run writes to a unique directory under the runner's ignored `runs/local/`.
It contains the exact patch, PR metadata, findings, ranked details, context
records and the reviewer's log. A requested fit assessment is saved and included
in the terminal or JSON report. Logs are written as the reviewer runs.

Exit codes are 0 when a review was produced, 1 for a failed review or tool
invocation, 2 for misuse or a reached severity threshold, 130 for SIGINT and
143 for SIGTERM.
