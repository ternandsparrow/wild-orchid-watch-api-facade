#!/bin/bash
# script to make it easier to start the server during dev by not having to
# recall the long-ish command needed.
set -euo pipefail
cd `dirname "$0"`

env \
  INAT_API_PREFIX=http://api.inat.x1eg2/v1 \
  CLIENT1_API_KEY=abc123 \
  yarn start${1:-}
