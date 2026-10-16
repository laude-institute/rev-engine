#!/usr/bin/env bash
#
# Builds the image and runs it on ReviewBench pull requests on this machine,
# through the benchmark's own scripts/try-agent.sh. Nothing is pushed anywhere.
#
#   scripts/local-run.sh <run-name> [--pr <index>] [--set test|full] [-e NAME[=VALUE] ...]
#
#   scripts/local-run.sh smoke --pr 0
#   JOBS=5 scripts/local-run.sh cheap -e RB_CONFIG_MODEL=vendor/model
#
# Needs a clone of https://github.com/review-bench/ReviewBench beside this
# repository, or at $REVIEWBENCH_DIR, and OPENROUTER_API_KEY in .env or the shell.
# Results land in runs/<run-name>/, which git ignores.
#
# JOBS=<n> runs n pull requests of the test set at a time. The full set shares
# repository checkouts between pull requests, so it always runs one at a time.
# PRS=0,3,7 limits a test set run to those indexes.
set -euo pipefail

[ $# -ge 1 ] || { sed -n '6,10p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
name="$1"; shift

here="$(cd "$(dirname "$0")/.." && pwd)"
bench="${REVIEWBENCH_DIR:-$here/../ReviewBench}"
[ -x "$bench/scripts/try-agent.sh" ] || { echo "no ReviewBench clone at $bench; set REVIEWBENCH_DIR" >&2; exit 2; }

if [ -f "$here/.env" ]; then set -a; . "$here/.env"; set +a; fi
[ -n "${OPENROUTER_API_KEY:-}" ] || { echo "OPENROUTER_API_KEY is not set" >&2; exit 2; }

image="${IMAGE:-rev-engine-prime:dev}"
docker build --quiet --platform linux/amd64 -t "$image" "$here" >/dev/null

run="$here/runs/$name"
mkdir -p "$run/logs" "$here/runs/.cache/repos" "$run/.try-agent"
# Share fetched repositories between runs; everything else stays per run.
[ -e "$run/.try-agent/repos" ] || ln -s "$here/runs/.cache/repos" "$run/.try-agent/repos"
cd "$run"

jobs="${JOBS:-1}"
prs="${PRS:-all}"
single=0
case " $* " in *" --pr "*|*" --set full "*) single=1 ;; esac

if [ "$single" -eq 1 ] || { [ "$jobs" -le 1 ] && [ "$prs" = all ]; }; then
  "$bench/scripts/try-agent.sh" "$image" -e OPENROUTER_API_KEY -e RB_CONTEXT_OUT=/work/out/context.json "$@" 2>&1 | tee "logs/run.log"
  exit "${PIPESTATUS[0]}"
fi

if [ "$prs" = all ]; then
  indexes=$(seq 0 $(($(jq length "$bench/corpus/test/test.json") - 1)))
else
  indexes=$(tr ',' '\n' <<<"$prs")
fi
count=$(wc -l <<<"$indexes" | tr -d ' ')
export bench image
rm -rf findings logs/pr-*.log
xargs -P "$jobs" -I{} sh -c \
  '"$bench/scripts/try-agent.sh" "$image" -e OPENROUTER_API_KEY -e RB_CONTEXT_OUT=/work/out/context.json --pr {} "$@" > "logs/pr-{}.log" 2>&1 || true' sh "$@" <<<"$indexes"
done_count=$(find findings -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
grep -h -E '^(==|   (ok|FAIL))' logs/pr-*.log || true
echo "$done_count of $count pull requests produced a valid findings file; logs in $run/logs" >&2
[ "$done_count" -eq "$count" ]
