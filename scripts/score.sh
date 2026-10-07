#!/usr/bin/env bash
#
# Scores one local run against the benchmark's golden findings with the
# benchmark's judging CLI, and totals what the run cost.
#
#   scripts/score.sh <run-name>
#
# JUDGE_PROVIDER and JUDGE_MODEL choose the judge (default: openrouter,
# google/gemini-3.5-flash). Scores from different judges are not comparable.
# Results land in runs/<run-name>/scoring/.
set -euo pipefail

[ $# -eq 1 ] || { sed -n '6p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
here="$(cd "$(dirname "$0")/.." && pwd)"
bench="${REVIEWBENCH_DIR:-$here/../ReviewBench}"
run="$here/runs/$1"
[ -d "$run/findings" ] || { echo "no findings in $run" >&2; exit 2; }

if [ -f "$here/.env" ]; then set -a; . "$here/.env"; set +a; fi
provider="${JUDGE_PROVIDER:-openrouter}"
model="${JUDGE_MODEL:-google/gemini-3.5-flash}"
mkdir -p "$run/scoring"

jq -s '{
  pull_requests: length,
  findings: (map(.findings | length) | add),
  cost_usd: (map(.usage.cost_usd) | add),
  mean_seconds: ((map(.usage.time_in_ms) | add) / length / 1000 | round),
  max_seconds: (map(.usage.time_in_ms) | max / 1000 | round),
  prompt_tokens: (map(.usage.prompt_tokens) | add),
  cached_tokens: (map(.usage.cached_tokens) | add),
  completion_tokens: (map(.usage.completion_tokens) | add),
  per_pull_request: map({key: "\(.pr.repo | sub("https://github.com/"; ""))#\(.pr.pr_number)", findings: (.findings | length), cost_usd: .usage.cost_usd, seconds: (.usage.time_in_ms / 1000 | round)})
}' "$run"/findings/*.json > "$run/scoring/usage.json"

cd "$bench"
[ -d node_modules ] || npm ci --no-audit --no-fund >/dev/null
npm run judge --silent -- \
  --candidate "$run/findings" \
  --provider "$provider" --model "$model" \
  --output "$run/scoring/results.json" \
  --repo-dir "$here/runs/.cache/judge-repos" \
  --concurrency "${JUDGE_JOBS:-5}" 2>&1 | tee "$run/scoring/judge.log" | sed -n '/Outcome Breakdown/,$p'
exit "${PIPESTATUS[0]}"
