#!/bin/bash
# wrapper to deploy to GCP cloud run and create the custom domain mapping if
# needed
set -euxo pipefail
cd "$(dirname "$0")"

: ${GCP_SERVICE_NAME}
: ${CUSTOM_DOMAIN}
: ${IMAGE_FULL}
secretPrefix=${GCP_SECRET_PREFIX:?should be DEV_ or PROD_}

source ./config-env.sh
commonParams="--platform managed --region ${GOOGLE_COMPUTE_ZONE:?}"

function getEnvParam {
  local key=$1
  local prefix="${2:-}"
  val=$(gcloud secrets versions access latest --secret ${prefix}${key})
  rc=$?
  if [ $rc != 0 ]; then
    return $rc
  fi
  echo "${key}=${val},"
}

function getOptionalEnvParam {
  getEnvParam $* || echo ''
}

# FIXME we should do a Sentry release, possibly using their docker image

# FIXME we can use the built-in secret mechanism described here
# https://cloud.google.com/run/docs/configuring/secrets#command-line, it uses
# this param for the deploy command:
#   --update-secrets=VAR_NAME1=SECRET_NAME:VERSION,VAR_NAME2=SECRET_NAME:VERSION
# can mix env vars with secrets depending on sensitivity. Need to add perm to
# deployer role so they can access secrets.

# FIXME could mount GCP JSON key as a file, so we don't have to base64 decode

if [ -n "${CIRCLE_JOB:-}" ]; then
  echo "hiding sensitive stuff from CircleCI logs"
  set +x
fi

# build set-env-vars value in a more readable way
ZZ=" $(getOptionalEnvParam INAT_API_PREFIX ${secretPrefix})"
ZZ+="$(getOptionalEnvParam INAT_PREFIX ${secretPrefix})"
ZZ+="$(getOptionalEnvParam INAT_PROJECT_SLUG ${secretPrefix})"
ZZ+="$(getOptionalEnvParam OAUTH_APP_ID ${secretPrefix})"
ZZ+="$(getEnvParam OAUTH_APP_SECRET ${secretPrefix})"
ZZ+="$(getEnvParam OAUTH_USERNAME ${secretPrefix})"
ZZ+="$(getEnvParam OAUTH_PASSWORD ${secretPrefix})"
ZZ+="$(getEnvParam GCS_BUCKET ${secretPrefix})"
ZZ+="$(getEnvParam GCP_QUEUE ${secretPrefix})"
ZZ+="$(getOptionalEnvParam LOG_LEVEL ${secretPrefix})"
ZZ+="DEPLOYED_ENV_NAME=${DEPLOYED_ENV_NAME},"

ZZ+="$(getEnvParam SENTRY_DSN)"
ZZ+="$(getOptionalEnvParam GCP_REGION)"
ZZ+="$(getEnvParam GCP_PROJECT)"
# could use "--service-account <some iam role>" but using GCP_KEY_JSON_BASE64
# mirrors local dev, so we know it works and it'll be easier to debug problems
ZZ+="$(getEnvParam GCP_KEY_JSON_BASE64 ${secretPrefix})"
ZZ+="$(getEnvParam CLIENT1_API_KEY ${secretPrefix})"
ZZ+="$(getEnvParam CLIENT2_API_KEY ${secretPrefix})"
ZZ+="$(getEnvParam CLIENT3_API_KEY ${secretPrefix})"
ZZ+="$(getEnvParam CLIENT4_API_KEY ${secretPrefix} | sed 's/,//')"

echo "[INFO] doing deploy"
gcloud beta run deploy $GCP_SERVICE_NAME \
  --image ${IMAGE_FULL:?} \
  --execution-environment gen2 \
  $commonParams \
  --allow-unauthenticated \
  --revision-suffix=${IMAGE_TAG:?} \
  --max-instances=1 \
  --cpu 1 \
  --memory 512Mi \
  --set-env-vars $ZZ
set -x

echo
echo "Service deployed"
echo

echo "[INFO] checking auto-allocated URL"
gcloud beta run services describe \
  $GCP_SERVICE_NAME \
  $commonParams \
  --format="value(status.address.url)"

if gcloud beta run domain-mappings describe \
    --domain $CUSTOM_DOMAIN \
    $commonParams &> /dev/null; then
  echo "[INFO] custom domain $CUSTOM_DOMAIN already exists, nothing to do"
else
  echo "[INFO] custom domain $CUSTOM_DOMAIN does NOT exist, creating..."
  # FIXME this command to create mappings is failing for me, with the error:
  # > ERROR: (gcloud.beta.run.domain-mappings.create) The provided domain does
  # >  not appear to be verified for the current account so a domain mapping
  # >  cannot be created. Visit
  # >  [https://cloud.google.com/run/docs/mapping-custom-domains/] for more
  # >  information.
  # > You currently have no verified domains
  # ...so the workaround is to create it in the web UI and that seems to work.
  # Maybe when Cloud Run is out of beta, it'll work *shrugs*.
  gcloud beta run domain-mappings create \
    --service $GCP_SERVICE_NAME \
    --domain $CUSTOM_DOMAIN \
    --force-override \
    $commonParams
fi

