#!/usr/bin/env bash
#
# Scores one local run against the benchmark's golden findings with the
# benchmark's judging CLI, and totals what the run cost.
#
#   scripts/score.sh <run-name>
#
# JUDGE_PROVIDER and JUDGE_MODEL choose the judge (default: openrouter,
# google/gemini-3.5-flash). Scores from different judges are not comparable.
# JUDGE_ARGS passes extra options to the judging CLI, such as --no-strict to
# accept a score when the judge itself fails on a pull request.
# SCORING_NAME names the output directory (default: scoring), so one run can
# be scored by several judges side by side.
# Results land in runs/<run-name>/<SCORING_NAME>/. judge-usage.json there totals
# the tokens the judge used to classify findings, and what they cost.
set -euo pipefail

[ $# -eq 1 ] || { sed -n '6p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
here="$(cd "$(dirname "$0")/.." && pwd)"
bench="${REVIEWBENCH_DIR:-$here/../ReviewBench}"
run="$here/runs/$1"
[ -d "$run/findings" ] || { echo "no findings in $run" >&2; exit 2; }

if [ -f "$here/.env" ]; then set -a; . "$here/.env"; set +a; fi
provider="${JUDGE_PROVIDER:-openrouter}"
model="${JUDGE_MODEL:-google/gemini-3.5-flash}"
out="$run/${SCORING_NAME:-scoring}"
mkdir -p "$out"

# The judging CLI only accepts models in its bundled registry, which lags behind
# OpenRouter. Register a missing model in a registry kept under runs/, leaving
# any registry in the user's home directory alone.
export PI_CODING_AGENT_DIR="$here/runs/.cache/judge-registry"
mkdir -p "$PI_CODING_AGENT_DIR"
rm -f "$PI_CODING_AGENT_DIR/models.json"
[ -d "$bench/node_modules" ] || (cd "$bench" && npm ci --no-audit --no-fund >/dev/null)
if [ "$provider" = openrouter ] && ! (cd "$bench" && npx pi --list-models 2>/dev/null | awk '$1 == "openrouter" {print $2}' | grep -qxF "$model"); then
  jq -n --arg id "$model" '{providers: {openrouter: {
    baseUrl: "https://openrouter.ai/api/v1", apiKey: "OPENROUTER_API_KEY", api: "openai-completions",
    models: [{id: $id, reasoning: true, input: ["text"], contextWindow: 1000000, maxTokens: 32000}]}}}' \
    > "$PI_CODING_AGENT_DIR/models.json"
fi

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
}' "$run"/findings/*.json > "$out/usage.json"

cd "$bench"
status=0
npm run judge --silent -- \
  --candidate "$run/findings" \
  --provider "$provider" --model "$model" \
  --output "$out/results.json" \
  --repo-dir "$here/runs/.cache/judge-repos" \
  --concurrency "${JUDGE_JOBS:-5}" ${JUDGE_ARGS:-} 2>&1 | tee "$out/judge.log" | sed -n '/Outcome Breakdown/,$p' || status=$?

# The judging CLI does not report what the judge cost. Its session logs hold the
# token counts of every call in the classifying step, so total those. A model
# registered above has no price in the logs; price it from OpenRouter's list.
sessions=()
while IFS= read -r session; do [ -f "$session" ] && sessions+=("$session"); done \
  < <(sed -n 's/^ *Session log: //p' "$out/judge.log")
if [ "${#sessions[@]}" -gt 0 ]; then
  prices=null
  [ "$provider" = openrouter ] && prices="$(curl -fsS --max-time 20 https://openrouter.ai/api/v1/models 2>/dev/null \
    | jq --arg id "$model" '.data[] | select(.id == $id) | .pricing' 2>/dev/null)"
  cat "${sessions[@]}" | jq -s --arg model "$model" --argjson sessions "${#sessions[@]}" --argjson prices "${prices:-null}" '
    def price($name): ($prices[$name] // "0") | tonumber;
    [.[] | select(.type == "message" and .message.role == "assistant") | .message.usage | select(. != null)] as $calls
    | { input_tokens: ($calls | map(.input // 0) | add // 0),
        output_tokens: ($calls | map(.output // 0) | add // 0),
        cache_read_tokens: ($calls | map(.cacheRead // 0) | add // 0),
        cache_write_tokens: ($calls | map(.cacheWrite // 0) | add // 0) } as $tokens
    | ($calls | map(.cost.total // 0) | add // 0) as $logged
    | { model: $model, step: "classifying only; the matching step is not logged", sessions: $sessions, calls: ($calls | length) }
      + $tokens
      + { cost_usd: (
            if $logged > 0 then $logged
            elif $prices == null then null
            else $tokens.input_tokens * price("prompt") + $tokens.output_tokens * price("completion")
              + $tokens.cache_read_tokens * price("input_cache_read") + $tokens.cache_write_tokens * price("input_cache_write")
            end) }' > "$out/judge-usage.json" || echo "could not total the judge usage" >&2
fi
exit "$status"
