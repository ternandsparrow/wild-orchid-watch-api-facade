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

# FIXME using fuse as a non-root user should work; it's the whole point! It
# doesn't seem to though. So we're forced to run as root :'(

cat <<HEREDOC > /etc/litestream.yml
dbs:
  - path: $DB_PATH
    replicas:
      - url: gcs://$GCS_BUCKET/wowfacade.db
HEREDOC

if [ -f "$DB_PATH" ]; then
  echo "Database already exists, skipping restore"
else
  echo "No database found, restoring from replica if exists"
  litestream restore -v -if-replica-exists "$DB_PATH"
fi

exec litestream replicate --exec 'node .'
