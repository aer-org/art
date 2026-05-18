#!/usr/bin/env bash
set -u
cat /workspace/extra/host-data/sample.txt > /dev/null 2>&1 \
  && echo 'HOST_READ_OK' || echo 'HOST_READ_FAIL'
echo '[STAGE_COMPLETE]'
