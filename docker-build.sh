#!/bin/bash
set -euo pipefail
cd `dirname "$0"`

imagePrefix=${IMAGE_PREFIX:-ternandsparrow/wild-orchid-watch-api-facade}
imageTag=${IMAGE_TAG:-dev}

docker build \
  -t $imagePrefix \
  -t $imagePrefix:$imageTag \
  --build-arg=GIT_SHA=$(git rev-parse --short HEAD) \
  .
