#/bin/bash
# starts and attaches to a bash shell in a Docker container that has the tools
# required to run this example.
set -euo pipefail
cd `dirname "$0"`

docker run \
  --rm \
  --user $(id -u):$(id -g) \
  --volume "$PWD":/home/node/project \
  --workdir /home/node/project \
  --entrypoint bash \
  -it \
  node:12
