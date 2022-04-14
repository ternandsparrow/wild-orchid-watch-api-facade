#!/bin/bash
set -euxo pipefail
cd "$(dirname "$0")"

trap 'exit 1' SIGINT

export GOOGLE_APPLICATION_CREDENTIALS=~/gcp-key.json
echo $GCP_KEY_JSON_BASE64 | base64 -d > $GOOGLE_APPLICATION_CREDENTIALS

# ignore whatever env var the user set, we control this one in docker
export UPLOAD_DIR_PATH=$UPLOAD_DIR_PATH_DOCKER

function doGcsfuse {
  local extraParams=${*:-}
  ${PREFIX_CMD:-} gcsfuse \
    --app-name wow-facade \
    ${extraParams} \
    $GCS_BUCKET \
    $UPLOAD_DIR_PATH
}

function helpDebugGcsfuse {
  set +e
  # get the strace output first, as it's long and we want the relevant (easier
  # to parse) logs as the newest lines
  PREFIX_CMD='strace -f' doGcsfuse
  id
  groups
  uname -a
  ls -l $(dirname $UPLOAD_DIR_PATH)
  ls -l /dev/fuse
  ls -l $(which fusermount)
  set -e
  doGcsfuse --foreground
}

echo "Mounting GCS Fuse."
mkdir -p $UPLOAD_DIR_PATH
doGcsfuse --debug_gcs --debug_fuse || helpDebugGcsfuse
echo "Mounting completed."

node .
