# intended to be sourced
set -euxo pipefail

if [ -n "${CIRCLE_JOB:-}" ]; then
  echo "hiding sensitive stuff from CircleCI logs"
  set +x
fi
keyFile=$HOME/gcloud-service-key.json
echo ${GCP_PROJECT_KEY:?} | base64 --decode --ignore-garbage > $keyFile

# these lines are for where we directly use gcloud cli
gcloud auth activate-service-account --key-file $keyFile
gcloud config set project ${GOOGLE_PROJECT_ID:?}

# this var used by gcp-gcr/gcr-auth step
echo "export GOOGLE_CLOUD_KEYS=\$(cat $keyFile)" >> $BASH_ENV

IMAGE_NAME=${CIRCLE_PROJECT_REPONAME:?}
echo "export IMAGE_NAME=$IMAGE_NAME" >> $BASH_ENV
export IMAGE_PREFIX=gcr.io/$GOOGLE_PROJECT_ID/$IMAGE_NAME
IMAGE_TAG=${CIRCLE_SHA1:?}
echo "export IMAGE_TAG=$IMAGE_TAG" >> $BASH_ENV
echo "export IMAGE_FULL=$IMAGE_PREFIX:$IMAGE_TAG" >> $BASH_ENV
cat $BASH_ENV # relax doesn't leak keys in logs
source $BASH_ENV
