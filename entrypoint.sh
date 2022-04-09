#!/bin/bash
set -euxo pipefail
cd "$(dirname "$0")"

export GOOGLE_APPLICATION_CREDENTIALS=~/gcp-key.json
echo $GCP_KEY_JSON_BASE64 | base64 -d > $GOOGLE_APPLICATION_CREDENTIALS

# ignore whatever env var the user set, we control this one in docker
export UPLOAD_DIR_PATH=$UPLOAD_DIR_PATH_DOCKER

echo "Mounting GCS Fuse."
mkdir -p $UPLOAD_DIR_PATH
# use "--foreground" to debug issues with gcsfuse
gcsfuse --app-name wow-facade --debug_gcs --debug_fuse $GCS_BUCKET $UPLOAD_DIR_PATH
echo "Mounting completed."

node .
