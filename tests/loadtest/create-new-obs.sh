#!/bin/bash

authToken=FIXME
curl \
 -X POST \
 'https://dev-api-facade.wildorchidwatch.org/observations/ab066540-2e5e-11ed-b313-fdf7206c966c' \
 -H "Authorization: $authToken" \
 -F projectId=4 \
 -F observation=@
 -F photos=@

