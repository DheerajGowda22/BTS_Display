#!/usr/bin/env bash
# Deploy or update Upcruit Hiring Pulse on AWS.
#
#   First run : packages the app, uploads it to a private S3 bucket, stores the staff PIN
#               in SSM Parameter Store (encrypted) and creates the CloudFormation stack.
#   Later runs: uploads the new version and restarts the app on the server. Data is kept.
#
# Usage (from the project folder, e.g. in AWS CloudShell):
#   bash deploy/aws/deploy.sh                       # free https://<ip>.sslip.io address
#   DOMAIN=pulse.upcruit.ai bash deploy/aws/deploy.sh
#   NEW_PIN=1 bash deploy/aws/deploy.sh             # change the staff PIN, then restart
#
# Optional settings: REGION (default ap-south-1, Mumbai), STACK (default hiring-pulse),
# INSTANCE_TYPE (default t3.small), BUCKET (default hiring-pulse-<account>-<region>).
set -euo pipefail

REGION="${REGION:-ap-south-1}"
STACK="${STACK:-hiring-pulse}"
DOMAIN="${DOMAIN:-}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.small}"
PIN_PARAM="/${STACK}/staff-pin"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

command -v aws >/dev/null || fail "AWS CLI not found. Use AWS CloudShell, or install the AWS CLI and run 'aws configure'."
command -v zip >/dev/null || fail "'zip' not found. Install it (e.g. sudo yum install -y zip / sudo apt install -y zip)."
command -v python3 >/dev/null || fail "python3 not found (it's preinstalled in AWS CloudShell)."
ssm_params() { python3 -c 'import json,sys; print(json.dumps({"commands":[sys.argv[1]]}))' "$1"; }

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[ -f "$ROOT/apps/server/src/server.js" ] || fail "Run this from inside the upcruit-hiring-pulse folder."
TEMPLATE="$ROOT/deploy/aws/hiring-pulse.yaml"

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)" || fail "AWS credentials aren't set up. Run 'aws configure' or use CloudShell."
BUCKET="${BUCKET:-${STACK}-${ACCOUNT}-${REGION}}"
say "Account $ACCOUNT · region $REGION · stack $STACK"

# ---------- 1. Private S3 bucket for releases ----------
if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  say "Creating private S3 bucket $BUCKET"
  if [ "$REGION" = "us-east-1" ]; then aws s3api create-bucket --bucket "$BUCKET" >/dev/null
  else aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration LocationConstraint="$REGION" >/dev/null; fi
  aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
fi

# ---------- 2. Package and upload this version ----------
say "Packaging the app"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
STAMP="$(date -u +%Y%m%d-%H%M%S)"
( cd "$ROOT/.." && zip -qr "$TMP/release.zip" "$(basename "$ROOT")" \
    -x "*/node_modules/*" "*/data/*" "*/.env" "*/.git/*" "*.zip" )
aws s3 cp "$TMP/release.zip" "s3://$BUCKET/releases/hiring-pulse-$STAMP.zip" --only-show-errors
aws s3 cp "$TMP/release.zip" "s3://$BUCKET/releases/current.zip" --only-show-errors
echo "Uploaded release $STAMP"

# ---------- 3. Staff PIN (encrypted in SSM Parameter Store) ----------
if [ -n "${NEW_PIN:-}" ] || ! aws ssm get-parameter --name "$PIN_PARAM" >/dev/null 2>&1; then
  say "Choose the staff PIN (8+ characters). It unlocks candidates' contact details on the Staff desk."
  while true; do
    read -r -s -p "Staff PIN: " PIN1; echo
    read -r -s -p "Repeat PIN: " PIN2; echo
    [ "$PIN1" = "$PIN2" ] || { echo "PINs don't match, try again."; continue; }
    [ "${#PIN1}" -ge 8 ] || { echo "Use at least 8 characters."; continue; }
    case "$PIN1" in *"'"*|*" "*) echo "Please don't use spaces or single quotes (')."; continue;; esac
    break
  done
  aws ssm put-parameter --name "$PIN_PARAM" --type SecureString --value "$PIN1" --overwrite >/dev/null
  unset PIN1 PIN2
  echo "Saved to SSM Parameter Store as $PIN_PARAM (encrypted)."
fi

# ---------- 4. Create the stack, or update the running server ----------
STATUS="$(aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo NONE)"

if [ "$STATUS" = "NONE" ] || [ "$STATUS" = "ROLLBACK_COMPLETE" ]; then
  if [ "$STATUS" = "ROLLBACK_COMPLETE" ]; then
    say "Removing a previous failed attempt"
    aws cloudformation delete-stack --stack-name "$STACK"
    aws cloudformation wait stack-delete-complete --stack-name "$STACK"
  fi
  say "Creating the server (about 5 minutes)"
  aws cloudformation deploy \
    --stack-name "$STACK" \
    --template-file "$TEMPLATE" \
    --capabilities CAPABILITY_IAM \
    --parameter-overrides BundleBucket="$BUCKET" StaffPinParameter="$PIN_PARAM" DomainName="$DOMAIN" InstanceType="$INSTANCE_TYPE" \
    --tags app=hiring-pulse
else
  case "$STATUS" in *_IN_PROGRESS) fail "Stack is busy ($STATUS). Wait a few minutes and run again.";; esac
  CURRENT_DOMAIN="$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Parameters[?ParameterKey=='DomainName'].ParameterValue" --output text)"
  [ "$CURRENT_DOMAIN" = "None" ] && CURRENT_DOMAIN=""
  if [ -n "$DOMAIN" ] && [ "$DOMAIN" != "$CURRENT_DOMAIN" ]; then
    say "Switching the address to $DOMAIN"
    INSTANCE_ID="$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)"
    [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || fail "DOMAIN should look like pulse.upcruit.ai"
    aws ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript \
      --parameters "$(ssm_params "sed -i 's/^SITE_DOMAIN=.*/SITE_DOMAIN=$DOMAIN/' /opt/hiring-pulse/settings.env")" >/dev/null
    sleep 5
    aws cloudformation deploy --stack-name "$STACK" --template-file "$TEMPLATE" --capabilities CAPABILITY_IAM \
      --parameter-overrides BundleBucket="$BUCKET" StaffPinParameter="$PIN_PARAM" DomainName="$DOMAIN" InstanceType="$INSTANCE_TYPE" \
      --no-fail-on-empty-changeset >/dev/null || true
  fi
fi

INSTANCE_ID="$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)"
URL="$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='Url'].OutputValue" --output text)"
IP="$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='PublicIP'].OutputValue" --output text)"

say "Waiting for the server to finish setting up"
aws ec2 wait instance-status-ok --instance-ids "$INSTANCE_ID"
for i in $(seq 1 60); do
  PING="$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$INSTANCE_ID" --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)"
  [ "$PING" = "Online" ] && break; sleep 10
done
[ "${PING:-}" = "Online" ] || fail "The server isn't reachable through Systems Manager yet. Run this script again in a few minutes."

run_on_server() {
  local CMD_ID STATE OUT
  CMD_ID="$(aws ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript \
    --comment "hiring-pulse: $1" --parameters "$(ssm_params "$2")" --query Command.CommandId --output text)"
  for i in $(seq 1 180); do
    sleep 5
    STATE="$(aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --query Status --output text 2>/dev/null || echo Pending)"
    case "$STATE" in Success|Failed|Cancelled|TimedOut) break;; esac
  done
  OUT="$(aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --query '[StandardOutputContent,StandardErrorContent]' --output text 2>/dev/null || true)"
  [ "$STATE" = "Success" ] || { echo "$OUT" | tail -40; fail "$1 failed on the server (status: $STATE)."; }
  echo "$OUT" | grep -E "live at|Started|Running" | tail -3 || true
}

# First boot runs the setup by itself; wait for it. Later runs push the new version.
run_on_server "first-boot setup" "cloud-init status --wait >/dev/null || { tail -40 /var/log/hiring-pulse-setup.log; exit 1; }; docker ps --format '{{.Names}}' | grep -q app && echo 'Running: app container is up'"
if [ "$STATUS" != "NONE" ] && [ "$STATUS" != "ROLLBACK_COMPLETE" ]; then
  say "Updating the app on the server (your data is kept)"
  run_on_server "update" "/opt/hiring-pulse/update.sh"
fi

say "Checking the site"
for i in $(seq 1 30); do
  if curl -fsS --max-time 5 "$URL/api/health" >/dev/null 2>&1; then OK=1; break; fi; sleep 10
done

echo
echo "  Address      : $URL"
echo "  TV display   : $URL/#display"
echo "  Booth tablet : $URL/#kiosk"
echo "  Staff desk   : $URL/#staff"
echo "  Public IP    : $IP"
echo "  Server shell : aws ssm start-session --target $INSTANCE_ID --region $REGION"
if [ -n "${OK:-}" ]; then
  say "Hiring Pulse is live."
else
  say "The server is up but HTTPS isn't answering yet."
  if [ -n "$DOMAIN" ]; then echo "Check that $DOMAIN has an A record pointing to $IP. The certificate is issued automatically once it does."
  else echo "The certificate can take a few minutes. Try the address again shortly."; fi
fi
