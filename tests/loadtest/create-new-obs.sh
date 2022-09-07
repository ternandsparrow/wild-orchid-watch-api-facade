#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

authToken=${1:?first param must be auth token to use}
theUuid=$(uuidgen)
pathToObsJson=$(mktemp)
bash ./generate-obs-json.sh $theUuid > $pathToObsJson

curl \
  -o /dev/null \
  -s \
  -w '%{http_code} %{time_total}s\n' \
  -X POST \
  "https://dev-api-facade.wildorchidwatch.org/observations/${theUuid}" \
  -H "Authorization: $authToken" \
  -F projectId=4 \
  -F "observation=@${pathToObsJson};type=application/json" \
  -F photos=@/tmp/wow-loadtest-photo1.jpg \
  -F photos=@/tmp/wow-loadtest-photo2.jpg \
  -F photos=@/tmp/wow-loadtest-photo3.jpg

