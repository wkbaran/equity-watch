#!/usr/bin/env bash
# Deploy infra/cloudformation.yaml, taking every parameter from .env.
#
# This exists because `aws cloudformation deploy` is destructive when you forget
# an argument. Every parameter in the template except BucketName defaults to
# empty or false, so a bare deploy against a live stack turns EnableOps off -
# deleting the Lambda, the SQS queue and the /api/* behaviour - blanks the ops
# token, and drops the custom domain and its certificate. Nothing warns you.
#
# So: put the values in .env once, run this, and they are passed every time.
#
#   ./scripts/deploy-stack.sh                      # values from .env
#   ./scripts/deploy-stack.sh CustomDomain=x.com   # ...with one overridden
#   ./scripts/deploy-stack.sh --dry-run            # print the command, run nothing
#
# Precedence per value: CLI argument > exported environment variable > .env.
# That is the same order dotenv gives the Node CLI, which does not override a
# variable already set in the environment.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$APP_DIR/.env"
TEMPLATE="$APP_DIR/infra/cloudformation.yaml"

dry_run=0
declare -A OVERRIDE=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    --help|-h) sed -n '2,18p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *=*) OVERRIDE["${arg%%=*}"]="${arg#*=}" ;;
    *) echo "Unrecognized argument: $arg (expected Key=Value, --dry-run or --help)" >&2; exit 2 ;;
  esac
done

# One key out of .env. Deliberately not `source`: .env holds values with spaces
# and '#' (an AWS secret key, the ops token), and sourcing would execute them.
env_file_value() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" | head -n1 | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# resolve <ParameterName> <ENV_VAR_NAME> [default]
resolve() {
  local param="$1" var="$2" fallback="${3-}" value
  if [ -n "${OVERRIDE[$param]+set}" ]; then
    printf '%s' "${OVERRIDE[$param]}"; return
  fi
  value="${!var-}"
  [ -n "$value" ] || value="$(env_file_value "$var")"
  printf '%s' "${value:-$fallback}"
}

STACK_NAME="$(resolve StackName STACK_NAME equity-watch-dashboard)"
REGION="$(resolve Region AWS_REGION us-east-1)"

# Every parameter the template takes, so the deploy never depends on what the
# AWS CLI does with the ones you leave out.
declare -A PARAMS=(
  [BucketName]="$(resolve BucketName S3_BUCKET)"
  [EnableOps]="$(resolve EnableOps ENABLE_OPS false)"
  [OpsToken]="$(resolve OpsToken OPS_TOKEN)"
  [EnableBasicAuth]="$(resolve EnableBasicAuth ENABLE_BASIC_AUTH false)"
  [BasicAuthUser]="$(resolve BasicAuthUser BASIC_AUTH_USER)"
  [BasicAuthPassword]="$(resolve BasicAuthPassword BASIC_AUTH_PASSWORD)"
  [CustomDomain]="$(resolve CustomDomain CUSTOM_DOMAIN)"
  [HostedZoneId]="$(resolve HostedZoneId HOSTED_ZONE_ID)"
)

if [ -z "${PARAMS[BucketName]}" ]; then
  echo "BucketName is required. Set S3_BUCKET in .env, or pass BucketName=..." >&2
  exit 2
fi
if [ -n "${PARAMS[CustomDomain]}" ] && [ -z "${PARAMS[HostedZoneId]}" ]; then
  echo "CustomDomain needs HostedZoneId (the PUBLIC Route 53 zone). Set HOSTED_ZONE_ID in .env." >&2
  exit 2
fi

# The guard this script is really for: refuse to blank a parameter the deployed
# stack currently has set. Without it, one missing .env line silently tears down
# ops or the custom domain, and the failure looks like the site breaking on its
# own some minutes later.
# tr -d '\r': the AWS CLI emits CRLF on Windows, which would leave every value
# ending in a carriage return - so "" reads as "\r" and the NoEcho mask "****"
# as "****\r", and neither matches the skip list below. Silent, and it makes the
# guard fire on parameters that are in fact empty.
existing="$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Parameters[].[ParameterKey,ParameterValue]' --output text 2>/dev/null | tr -d '\r' || true)"
if [ -n "$existing" ]; then
  clearing=()
  while IFS=$'\t' read -r key value; do
    [ -n "$key" ] || continue
    # "****" is how a NoEcho parameter reads back, so its real value can never be
    # recovered from the stack - which is the whole reason it has to live in .env.
    case "$value" in ""|"false"|"****") continue ;; esac
    [ -n "${PARAMS[$key]+set}" ] || continue
    resolved="${PARAMS[$key]}"
    # Empty is the obvious clearing case. true -> false is the dangerous one and
    # is NOT empty, so an earlier version of this let it through: EnableOps
    # resolving to its default would have deleted the Lambda, the queue and the
    # /api/* behaviour on a stack that had them.
    if [ -z "$resolved" ] || { [ "$value" = "true" ] && [ "$resolved" = "false" ]; }; then
      clearing+=("$key")
    fi
  done <<< "$existing"
  if [ ${#clearing[@]} -gt 0 ]; then
    echo "Refusing to deploy: these are set on the live stack and this deploy would clear them:" >&2
    printf '  %s\n' "${clearing[@]}" >&2
    echo "Set them in .env (see .env.example), or pass Key=Value to deploy anyway." >&2
    exit 1
  fi
fi

overrides=()
for key in "${!PARAMS[@]}"; do
  overrides+=("$key=${PARAMS[$key]}")
done

# Secrets are redacted in what we print, but note they are still visible in the
# process list while `aws` runs - that is true of any --parameter-overrides use.
printf 'Deploying %s to %s:\n' "$STACK_NAME" "$REGION"
for key in $(printf '%s\n' "${!PARAMS[@]}" | sort); do
  case "$key" in
    OpsToken|BasicAuthPassword) printf '  %-18s %s\n' "$key" "$([ -n "${PARAMS[$key]}" ] && echo '(set)' || echo '(empty)')" ;;
    *) printf '  %-18s %s\n' "$key" "${PARAMS[$key]:-(empty)}" ;;
  esac
done

if [ "$dry_run" -eq 1 ]; then
  echo "(--dry-run: nothing was deployed)"
  exit 0
fi

aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --template-file "$TEMPLATE" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides "${overrides[@]}"

aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs' --output table
