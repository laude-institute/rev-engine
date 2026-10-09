#!/usr/bin/env bash
#
# Runs experiments on an EC2 box instead of this machine, so a run survives a
# closed laptop or a bad connection. The box has no inbound access; every
# command goes through AWS Systems Manager, and results come back through S3.
#
#   scripts/box.sh up                 create the box (or start it) and wait until it is ready
#   scripts/box.sh start <queue-file> send this checkout and a queue of experiments, and start them
#   scripts/box.sh status [lines]     show whether a queue is running and the tail of its log
#   scripts/box.sh fetch              download finished results into runs/box/
#   scripts/box.sh stop               stop the running queue and its containers
#   scripts/box.sh stop-at <time>     stop the box at a UTC time, such as "19:00" or "+16 hours"
#   scripts/box.sh down               stop the box; its disk and caches are kept
#   scripts/box.sh destroy            delete the box, its role and its stored key; the bucket is kept
#
# The queue file format is described in scripts/box-queue.sh. The box keeps
# running when a queue finishes, unless STOP_BOX_AFTER_RUN=1 is set for `start`.
# Use `stop-at` or `down` so a forgotten box does not run for days.
#
# Needs the AWS CLI with credentials for the account, jq, and OPENROUTER_API_KEY
# in .env for `up`. BOX_REGION (default us-east-1) and BOX_INSTANCE_TYPE
# (default m7i.2xlarge) can be overridden.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
name=rev-engine-prime
region="${BOX_REGION:-us-east-1}"
instance_type="${BOX_INSTANCE_TYPE:-m7i.2xlarge}"
parameter="/$name/openrouter-api-key"
role="$name-box"
aws() { command aws --region "$region" "$@"; }
account="$(aws sts get-caller-identity --query Account --output text)"
bucket="$name-$account"

instance_id() {
  aws ec2 describe-instances \
    --filters "Name=tag:Name,Values=$name-box" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[].InstanceId' --output text | awk '{print $1}'
}

# Runs the script on stdin as root on the box and prints its output.
remote() {
  local instance script command status
  instance="$(instance_id)"
  [ -n "$instance" ] || { echo "there is no box; run: scripts/box.sh up" >&2; exit 1; }
  # Systems Manager runs commands with sh; hand the script to bash intact.
  script="echo $(base64 < /dev/stdin | tr -d '\n') | base64 -d | bash"
  command="$(aws ssm send-command --instance-ids "$instance" --document-name AWS-RunShellScript \
    --parameters "$(jq -n --arg script "$script" --arg timeout "${REMOTE_TIMEOUT:-900}" '{commands: [$script], executionTimeout: [$timeout]}')" \
    --query Command.CommandId --output text)"
  while :; do
    sleep 2
    status="$(aws ssm get-command-invocation --command-id "$command" --instance-id "$instance" --query Status --output text 2>/dev/null || echo Pending)"
    case "$status" in Pending|InProgress|Delayed) ;; *) break ;; esac
  done
  aws ssm get-command-invocation --command-id "$command" --instance-id "$instance" --query StandardOutputContent --output text
  [ "$status" = Success ] || {
    aws ssm get-command-invocation --command-id "$command" --instance-id "$instance" --query StandardErrorContent --output text >&2
    return 1
  }
}

wait_ready() {
  local instance="$1"
  aws ec2 wait instance-running --instance-ids "$instance"
  echo "waiting for the box to accept commands" >&2
  until [ "$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$instance" --query 'InstanceInformationList[0].PingStatus' --output text)" = Online ]; do sleep 5; done
  REMOTE_TIMEOUT=1200 remote <<<'cloud-init status --wait >/dev/null 2>&1 || true; test -f /srv/rev/.ready && echo "box is ready" || { echo "setup did not finish; see /var/log/cloud-init-output.log"; exit 1; }'
}

case "${1:-}" in
  up)
    [ -f "$here/.env" ] && { set -a; . "$here/.env"; set +a; }
    [ -n "${OPENROUTER_API_KEY:-}" ] || { echo "OPENROUTER_API_KEY is not set" >&2; exit 2; }

    aws s3api head-bucket --bucket "$bucket" >/dev/null 2>&1 || {
      if [ "$region" = us-east-1 ]; then aws s3api create-bucket --bucket "$bucket" >/dev/null
      else aws s3api create-bucket --bucket "$bucket" --create-bucket-configuration "LocationConstraint=$region" >/dev/null; fi
      aws s3api put-public-access-block --bucket "$bucket" --public-access-block-configuration \
        BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
    }

    # The key goes in through a file so it never appears on a command line.
    secret="$(mktemp)"; trap 'rm -f "$secret"' EXIT
    jq -n --arg name "$parameter" --arg value "$OPENROUTER_API_KEY" '{Name: $name, Value: $value, Type: "SecureString", Overwrite: true}' > "$secret"
    aws ssm put-parameter --cli-input-json "file://$secret" >/dev/null

    aws iam get-role --role-name "$role" >/dev/null 2>&1 || {
      aws iam create-role --role-name "$role" --assume-role-policy-document \
        '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
      aws iam attach-role-policy --role-name "$role" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
      aws iam create-instance-profile --instance-profile-name "$role" >/dev/null
      aws iam add-role-to-instance-profile --instance-profile-name "$role" --role-name "$role"
    }
    aws iam put-role-policy --role-name "$role" --policy-name "$name-box" --policy-document "$(jq -n \
      --arg bucket "arn:aws:s3:::$bucket" --arg parameter "arn:aws:ssm:$region:$account:parameter$parameter" '{
        Version: "2012-10-17",
        Statement: [
          {Effect: "Allow", Action: ["s3:ListBucket"], Resource: $bucket},
          {Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject"], Resource: "\($bucket)/*"},
          {Effect: "Allow", Action: ["ssm:GetParameter"], Resource: $parameter}
        ]}')"

    instance="$(instance_id)"
    if [ -z "$instance" ]; then
      vpc="$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)"
      group="$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$name-box" "Name=vpc-id,Values=$vpc" --query 'SecurityGroups[0].GroupId' --output text)"
      [ "$group" != None ] || group="$(aws ec2 create-security-group --group-name "$name-box" --vpc-id "$vpc" \
        --description "Experiment box: no inbound access" --query GroupId --output text)"
      image="$(aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text)"
      user_data="$(mktemp)"
      cat > "$user_data" <<'SETUP'
#!/bin/bash
set -eux
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io git jq unzip curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscli.zip
unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install
systemctl enable --now docker
mkdir -p /srv/rev/runs /srv/rev/logs
touch /srv/rev/.ready
SETUP
      sleep 10 # a new instance profile takes a moment to become usable
      instance="$(aws ec2 run-instances --image-id "$image" --instance-type "$instance_type" \
        --iam-instance-profile "Name=$role" --security-group-ids "$group" \
        --instance-initiated-shutdown-behavior stop \
        --metadata-options HttpTokens=required,HttpPutResponseHopLimit=1 \
        --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=150,VolumeType=gp3,Encrypted=true}' \
        --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$name-box},{Key=project,Value=$name}]" \
        --user-data "file://$user_data" --query 'Instances[0].InstanceId' --output text)"
      rm -f "$user_data"
      echo "created $instance ($instance_type)" >&2
    else
      aws ec2 start-instances --instance-ids "$instance" >/dev/null
    fi
    wait_ready "$instance"
    ;;

  start)
    queue="${2:?usage: scripts/box.sh start <queue-file>}"
    [ -f "$queue" ] || { echo "no queue file at $queue" >&2; exit 2; }
    id="$(date -u +%Y%m%dT%H%M%SZ)"
    package="$(mktemp -d)/code.tar.gz"
    (cd "$here" && git ls-files -co --exclude-standard -z | COPYFILE_DISABLE=1 tar --no-xattrs --null -T - -czf "$package")
    aws s3 cp "$package" "s3://$bucket/code/$id.tar.gz" --only-show-errors
    aws s3 cp "$queue" "s3://$bucket/code/$id.queue" --only-show-errors
    remote <<BOX
set -euo pipefail
export HOME=/root
systemctl is-active --quiet rev-queue && { echo "a queue is already running; see: scripts/box.sh status"; exit 1; }
systemctl reset-failed rev-queue 2>/dev/null || true
shutdown -c 2>/dev/null || true
rm -rf /srv/rev/code && mkdir -p /srv/rev/code /srv/rev/runs /srv/rev/logs
aws --region $region s3 cp s3://$bucket/code/$id.tar.gz /srv/rev/code.tar.gz --only-show-errors
tar -xzf /srv/rev/code.tar.gz -C /srv/rev/code
aws --region $region s3 cp s3://$bucket/code/$id.queue /srv/rev/queue --only-show-errors
ln -sfn /srv/rev/runs /srv/rev/code/runs
if [ -d /srv/rev/ReviewBench/.git ]; then git -C /srv/rev/ReviewBench pull -q --ff-only || true
else git clone -q --depth 1 https://github.com/review-bench/ReviewBench.git /srv/rev/ReviewBench; fi
(cd /srv/rev/ReviewBench && npm ci --no-audit --no-fund >/dev/null 2>&1)
ln -sfn /srv/rev/logs/$id.log /srv/rev/logs/current.log
systemd-run --unit rev-queue --collect \
  --setenv=HOME=/root --setenv=BOX_BUCKET=$bucket --setenv=BOX_REGION=$region --setenv=BOX_KEY_PARAMETER=$parameter \
  --setenv=STOP_BOX_AFTER_RUN=$([ "${STOP_BOX_AFTER_RUN:-0}" = 1 ] && echo 1 || echo 0) --setenv=JOBS=${JOBS:-8} \
  --setenv=JUDGE_MODEL=${JUDGE_MODEL:-google/gemini-3.5-flash} \
  --property=StandardOutput=file:/srv/rev/logs/$id.log --property=StandardError=inherit \
  /bin/bash /srv/rev/code/scripts/box-queue.sh /srv/rev/queue
echo "started queue $id"
BOX
    ;;

  status)
    state="$(aws ec2 describe-instances --instance-ids "$(instance_id)" --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null || echo none)"
    echo "box: $state"
    [ "$state" = running ] || exit 0
    remote <<BOX
echo "queue: \$(systemctl is-active rev-queue || true)"
systemctl is-active --quiet rev-stop-at.timer && echo "stops at: \$(systemctl show rev-stop-at.timer --property=NextElapseUSecRealtime --value)"
tail -n ${2:-30} /srv/rev/logs/current.log 2>/dev/null | cut -c1-200
BOX
    ;;

  fetch)
    mkdir -p "$here/runs/box"
    aws s3 sync "s3://$bucket/runs" "$here/runs/box" --only-show-errors
    for summary in "$here"/runs/box/*/scoring/results.json; do [ -f "$summary" ] && echo "${summary%/scoring/results.json}"; done
    ;;

  stop)
    remote <<'BOX'
systemctl stop rev-queue 2>/dev/null || true
docker ps -q --filter ancestor=rev-engine-prime:dev | xargs -r docker stop -t 5 >/dev/null
shutdown -c 2>/dev/null || true
echo stopped
BOX
    ;;

  stop-at)
    [ -n "${2:-}" ] || { echo 'usage: scripts/box.sh stop-at <time>' >&2; exit 2; }
    # A timer of its own, because `start` cancels any pending `shutdown`.
    remote <<BOX
set -euo pipefail
when="\$(date -u -d "$2" '+%Y-%m-%d %H:%M:%S')"
systemctl stop rev-stop-at.timer 2>/dev/null || true
systemctl reset-failed rev-stop-at.service 2>/dev/null || true
systemd-run --quiet --unit rev-stop-at --on-calendar "\$when UTC" /sbin/shutdown -h now
echo "the box will stop at \$when UTC"
BOX
    ;;

  down)
    aws ec2 stop-instances --instance-ids "$(instance_id)" --query 'StoppingInstances[0].CurrentState.Name' --output text
    ;;

  destroy)
    instance="$(instance_id)"
    [ -z "$instance" ] || { aws ec2 terminate-instances --instance-ids "$instance" >/dev/null; aws ec2 wait instance-terminated --instance-ids "$instance"; }
    aws ssm delete-parameter --name "$parameter" 2>/dev/null || true
    aws iam remove-role-from-instance-profile --instance-profile-name "$role" --role-name "$role" 2>/dev/null || true
    aws iam delete-instance-profile --instance-profile-name "$role" 2>/dev/null || true
    aws iam delete-role-policy --role-name "$role" --policy-name "$name-box" 2>/dev/null || true
    aws iam detach-role-policy --role-name "$role" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore 2>/dev/null || true
    aws iam delete-role --role-name "$role" 2>/dev/null || true
    echo "deleted the box, its role and its stored key; results remain in s3://$bucket"
    ;;

  *)
    sed -n '7,14p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac
