# Run it locally

`scripts/local.ts` runs the reviewer on a git checkout, without Docker and
without ReviewBench. It computes the input the container expects from a working
copy and then starts the same `src/main.ts` the benchmark and the Action use, so
a review on a laptop goes through the same code path.

```sh
node scripts/local.ts branch --base main     # the current branch, before a pull request
node scripts/local.ts pr 1938                # a pull request at its head
node scripts/local.ts doctor                 # node, git, gh, settings and the key
```

Both modes need Node 24 or newer and an OpenRouter key in `OPENROUTER_API_KEY`,
unless the branch you are on gives the reviewer another way to reach a model.

## Modes

| Mode | Reviews | Tree |
|---|---|---|
| `branch` | `git diff <merge-base(base, HEAD)>..HEAD` | your working copy, which must be clean |
| `pr <number>` | the pull request at its head, read with `gh` | a detached worktree under the system temporary directory |

`RB_BASE` is the merge-base in both modes, so `read_base_file` returns what
GitHub shows as the base version and the diff is the same three-dot diff the pull
request page shows. `branch` refuses a dirty tree because the reviewer reads
files at head from the tree: uncommitted edits would be invisible to it and the
review would describe code that is not there.

`pr` mode leaves your checkout untouched. It fetches the head, adds a worktree,
reviews that, and removes the worktree afterwards unless `--keep` is given.

## Settings

Every setting flag sets the container variable of the same name, so
`--min-severity high` is `RB_CONFIG_MIN_SEVERITY=high`. `--set KEY=VALUE` covers
the rest, and the names are the ones in [SETTINGS.md](SETTINGS.md).

| Flag | Setting |
|---|---|
| `--model` | `RB_CONFIG_MODEL` |
| `--verifier` | `RB_CONFIG_VERIFIER` |
| `--verify` | `RB_CONFIG_VERIFY` |
| `--second-look` | `RB_CONFIG_SECOND_LOOK` |
| `--mode` | `RB_CONFIG_MODE` |
| `--min-severity` | `RB_CONFIG_MIN_SEVERITY` |
| `--max-findings` | `RB_CONFIG_MAX_FINDINGS` |
| `--time-budget` | `RB_CONFIG_TIME_BUDGET` |
| `--max-turns` | `RB_CONFIG_MAX_TURNS` |
| `--effort` | `RB_CONFIG_EFFORT` |
| `--fit` | `RB_CONFIG_FIT` |
| `--engine` | `RB_CONFIG_ENGINE`, only on a branch that defines it |

A setting the checkout does not define is not passed at all: the reviewer would
reject an unknown `RB_CONFIG_*` name, so `--engine` fails with an explanation on
a branch without an engine setting rather than starting a run that cannot work.

Other flags: `--repo <path>` (default `.`), `--base <ref>`, `--json` for machine
readable output, `--fail-on high|medium|low` to exit 2 on findings at or above
that severity, `--quiet` to suppress the reviewer's progress, `--dry-run` to
print the computed environment without reviewing, and `--keep` to leave the `pr`
worktree in place.

## Output

A run writes its findings, its ranked details, what each reviewer read, and the
reviewer's log to `runs/local/<timestamp>-<mode>-<sha>/`, which git ignores. The
summary printed to the terminal comes from `out/details.json`, because that file
keeps each finding's severity apart while the contract's findings file does not.

Exit codes: `0` a review was produced, `1` the reviewer failed, `2` misuse or a
gate threshold was reached.
