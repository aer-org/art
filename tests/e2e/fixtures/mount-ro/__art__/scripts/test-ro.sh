#!/usr/bin/env bash
set -u
cat /workspace/src/existing.txt > /dev/null 2>&1 && echo 'READ_OK' || echo 'READ_FAIL'
touch /workspace/src/newfile.txt 2>/dev/null && echo 'WRITE_OK' || echo 'WRITE_FAIL'
echo '[STAGE_COMPLETE]'
