#!/usr/bin/env bash
#
# Runs on the experiment box, started by scripts/box.sh. Works through a queue
# of experiments one at a time: review, score, upload. Nothing here needs the
# laptop to stay connected.
#
#   scripts/box-queue.sh <queue-file>
#
# Each queue line is:  <run-name> <prs> [NAME=VALUE ...]
#   <prs> is "all" or a comma-separated list of test set indexes.
#   NAME=VALUE pairs are passed to the container, for example RB_CONFIG_MODEL=vendor/model.
# A line with "score" in place of <prs> scores a run already on the box again;
# its NAME=VALUE pairs go to scripts/score.sh, for example JUDGE_MODEL and SCORING_NAME.
# Lines starting with # are skipped.
set -uo pipefail

queue="$1"
here="$(cd "$(dirname "$0")/.." && pwd)"
: "${BOX_BUCKET:?}" "${BOX_REGION:?}" "${BOX_KEY_PARAMETER:?}"
export REVIEWBENCH_DIR="${REVIEWBENCH_DIR:-/srv/rev/ReviewBench}"
OPENROUTER_API_KEY="$(aws --region "$BOX_REGION" ssm get-parameter --with-decryption --name "$BOX_KEY_PARAMETER" --query Parameter.Value --output text)"
export OPENROUTER_API_KEY

cd "$here"
while read -r name prs settings <&3; do
  case "$name" in ''|'#'*) continue ;; esac
  echo "=== $(date -u +%FT%TZ) start $name (prs: $prs; $settings)"
  if [ "$prs" = score ]; then
    # Score a run that is already on the box. Settings here go to scripts/score.sh.
    # shellcheck disable=SC2086
    env $settings scripts/score.sh "$name" || echo "=== $name: scoring failed"
  else
    args=()
    for setting in $settings; do args+=(-e "$setting"); done
    PRS="$prs" JOBS="${JOBS:-8}" scripts/local-run.sh "$name" "${args[@]}" || echo "=== $name: some pull requests failed"
    printf '%s\n' "$name $prs $settings" > "runs/$name/experiment.txt"
    scripts/score.sh "$name" || echo "=== $name: scoring failed"
  fi
  aws --region "$BOX_REGION" s3 sync "runs/$name" "s3://$BOX_BUCKET/runs/$name" --exclude ".try-agent/*" --only-show-errors
  echo "=== $(date -u +%FT%TZ) done $name"
done 3< "$queue"

echo "=== queue finished"
if [ "${STOP_BOX_AFTER_RUN:-0}" = 1 ]; then
  echo "=== stopping the box in one minute"
  shutdown -h +1
fi
