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

function getSecret {
  gcloud secrets versions access latest --secret $1
}

function getOptionalSecret {
  getSecret || echo ''
}

# FIXME we should do a Sentry release

# build set-env-vars value in a more readable way
ZZ=" INAT_API_PREFIX=$(  getOptionalSecret ${secretPrefix}INAT_API_PREFIX),"
ZZ+="INAT_PREFIX=$(      getOptionalSecret ${secretPrefix}INAT_PREFIX),"
ZZ+="INAT_PROJECT_SLUG=$(getOptionalSecret ${secretPrefix}INAT_PROJECT_SLUG),"
ZZ+="OAUTH_APP_ID=$(     getOptionalSecret ${secretPrefix}OAUTH_APP_ID),"
ZZ+="OAUTH_APP_SECRET=$( getSecret ${secretPrefix}OAUTH_APP_SECRET),"
ZZ+="OAUTH_USERNAME=$(   getSecret ${secretPrefix}OAUTH_USERNAME),"
ZZ+="OAUTH_PASSWORD=$(   getSecret ${secretPrefix}OAUTH_PASSWORD),"
ZZ+="GCS_BUCKET=$(       getSecret ${secretPrefix}GCS_BUCKET),"
ZZ+="GCP_QUEUE=$(        getSecret ${secretPrefix}GCP_QUEUE),"

ZZ+="SENTRY_DSN=$(       getSecret SENTRY_DSN),"
ZZ+="GCP_REGION=$(       getSecret GCP_REGION),"
ZZ+="GCP_PROJECT=$(      getSecret GCP_PROJECT),"
# could use "--service-account fs-identity" but using GCP_KEY_JSON_BASE64
# mirrors local dev, so we know it works and it'll be easier to debug problems
ZZ+="GCP_KEY_JSON_BASE64=$(getSecret GCP_KEY_JSON_BASE64),"
ZZ+="CLIENT1_API_KEY=$(getSecret CLIENT1_API_KEY),"
ZZ+="CLIENT2_API_KEY=$(getSecret CLIENT2_API_KEY),"
ZZ+="CLIENT3_API_KEY=$(getSecret CLIENT3_API_KEY),"
ZZ+="CLIENT4_API_KEY=$(getSecret CLIENT4_API_KEY)"

gcloud beta run deploy $GCP_SERVICE_NAME \
  --image ${IMAGE_FULL:?} \
  --execution-environment gen2 \
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

