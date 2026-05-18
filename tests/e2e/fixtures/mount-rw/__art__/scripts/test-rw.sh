#!/usr/bin/env bash
set -u
echo 'hello' > /workspace/src/written.txt 2>/dev/null \
  && cat /workspace/src/written.txt | grep -q hello \
  && echo 'WRITE_OK' || echo 'WRITE_FAIL'
echo '[STAGE_COMPLETE]'
