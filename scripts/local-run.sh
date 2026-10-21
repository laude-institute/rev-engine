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
#
# Each run reviews in its own copy of the fetched repositories, so several runs,
# even of the same pull request, can go at once. On APFS the copy shares storage
# with runs/.cache/repos and takes about a second.
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
cache="$here/runs/.cache/repos"
mkdir -p "$run/logs" "$cache" "$run/.try-agent"
# A review checks out and cleans its repository in place, so two runs sharing one
# checkout would collide. Each run starts from a copy of the cache instead, and
# repositories it fetched for the first time go back to the cache when it ends.
if [ ! -e "$run/.try-agent/repos" ]; then
  cp -cR "$cache" "$run/.try-agent/repos" 2>/dev/null || cp -R "$cache" "$run/.try-agent/repos"
fi
keep_new_repos() {
  [ -d "$run/.try-agent/repos" ] && [ ! -L "$run/.try-agent/repos" ] || return 0
  for dir in "$run/.try-agent/repos"/*/; do
    [ -d "$dir" ] || continue
    target="$cache/$(basename "$dir")"
    [ -e "$target" ] || cp -cR "$dir" "$target" 2>/dev/null || cp -R "$dir" "$target" || true
  done
}
trap keep_new_repos EXIT
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
review() {
  xargs -P "$jobs" -I{} sh -c \
    '"$bench/scripts/try-agent.sh" "$image" -e OPENROUTER_API_KEY -e RB_CONTEXT_OUT=/work/out/context.json --pr {} "$@" > "logs/pr-{}.log" 2>&1 || true' sh "$@"
}
review "$@" <<<"$indexes"
# Docker on an arm64 Mac runs the amd64 image under emulation, and now and then the
# container crashes at start with exit code 139 before the reviewer prints anything.
# Those pull requests are reviewed once more.
crashed=$(grep -l "FAIL: exit code 139" logs/pr-*.log 2>/dev/null | sed -E 's/.*pr-([0-9]+)\.log$/\1/' || true)
if [ -n "$crashed" ]; then
  echo "reviewing again after a crash at start (exit code 139): $(tr '\n' ' ' <<<"$crashed")" >&2
  review "$@" <<<"$crashed"
fi
done_count=$(find findings -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
grep -h -E '^(==|   (ok|FAIL))' logs/pr-*.log || true
echo "$done_count of $count pull requests produced a valid findings file; logs in $run/logs" >&2
[ "$done_count" -eq "$count" ]
