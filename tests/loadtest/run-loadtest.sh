#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

concurrency=${1:?first param must be number of concurrent requests}
authToken=${2:?second param must be auth token to use}

for i in $(seq 1 $concurrency); do
  bash ./create-new-obs.sh $authToken &
done

wait
