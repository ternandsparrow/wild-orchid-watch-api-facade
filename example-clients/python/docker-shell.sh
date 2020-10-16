#/bin/bash
# starts and attaches to a bash shell in a Docker container that has the tools
# required to run this example.
set -euo pipefail
cd `dirname "$0"`

docker run \
  --rm \
  --volume "$PWD":/project:ro \
  --workdir /project \
  --entrypoint bash \
  -it \
  python:3.8-buster
