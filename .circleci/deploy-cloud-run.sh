#!/bin/bash
# wrapper to deploy to GCP cloud run and create the custom domain mapping if
# needed
set -euxo pipefail
cd "$(dirname "$0")"

: ${GCP_SERVICE_NAME:-}
: ${CUSTOM_DOMAIN:-}
: ${TAG:-}
commonParams="--platform managed --region ${GOOGLE_COMPUTE_ZONE:?}"

function getSecret {
  gcloud secrets versions access latest --secret="$1"
}

# build set-env-vars value in a more readable way
ZZ=" INAT_API_PREFIX=$(getSecret INAT_API_PREFIX),"
ZZ+="INAT_PREFIX=$(getSecret INAT_PREFIX),"
ZZ+="INAT_PROJECT_SLUG=$(getSecret INAT_PROJECT_SLUG),"
ZZ+="OAUTH_APP_ID=$(getSecret OAUTH_APP_ID),"
ZZ+="OAUTH_APP_SECRET=$(getSecret OAUTH_APP_SECRET),"
ZZ+="OAUTH_USERNAME=$(getSecret OAUTH_USERNAME),"
ZZ+="OAUTH_PASSWORD=$(getSecret OAUTH_PASSWORD),"
ZZ+="SENTRY_DSN=$(getSecret SENTRY_DSN),"
ZZ+="CLIENT1_API_KEY=$(getSecret CLIENT1_API_KEY),"
ZZ+="CLIENT2_API_KEY=$(getSecret CLIENT2_API_KEY),"
ZZ+="CLIENT3_API_KEY=$(getSecret CLIENT3_API_KEY),"
ZZ+="CLIENT4_API_KEY=$(getSecret CLIENT4_API_KEY)"

source ./config-image-name-env-vars.sh

gcloud beta run deploy $GCP_SERVICE_NAME \
  --image ${IMAGE_FULL:?} \
  $commonParams \
  --allow-unauthenticated \
  --set-env-vars $ZZ

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
  gcloud beta run domain-mappings create \
    --service $GCP_SERVICE_NAME \
    --domain $CUSTOM_DOMAIN \
    $commonParams
fi

