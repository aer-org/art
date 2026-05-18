#!/usr/bin/env bash
set -u
cat /workspace/project/README.md > /dev/null 2>&1 \
  && echo 'PROJECT_READ_OK' || echo 'PROJECT_READ_FAIL'
touch /workspace/project/nope.txt 2>/dev/null \
  && echo 'PROJECT_WRITE_OK' || echo 'PROJECT_WRITE_FAIL'
echo 'gen' > /workspace/project/src/generated/output.txt 2>/dev/null \
  && echo 'SUB_WRITE_OK' || echo 'SUB_WRITE_FAIL'
cat /workspace/project/__art__/PIPELINE.json > /dev/null 2>&1 \
  && echo 'ART_VISIBLE' || echo 'ART_HIDDEN'
echo '[STAGE_COMPLETE]'
