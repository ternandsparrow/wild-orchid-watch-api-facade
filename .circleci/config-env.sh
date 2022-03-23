# intended to be sourced
echo ${GCP_PROJECT_KEY} | base64 --decode \
  --ignore-garbage > $HOME/gcloud-service-key.json
echo 'export GOOGLE_CLOUD_KEYS=$(cat $HOME/gcloud-service-key.json)' >> $BASH_ENV
IMAGE_NAME=$CIRCLE_PROJECT_REPONAME
echo 'export IMAGE_NAME=$IMAGE_NAME' >> $BASH_ENV
export IMAGE_PREFIX=gcr.io/${GOOGLE_PROJECT_ID:?}/$IMAGE_NAME
export IMAGE_TAG=${CIRCLE_SHA1:?}
IMAGE_FULL=$IMAGE_PREFIX:$IMAGE_TAG
echo 'export IMAGE_FULL=$IMAGE_FULL' >> $BASH_ENV
source $BASH_ENV
