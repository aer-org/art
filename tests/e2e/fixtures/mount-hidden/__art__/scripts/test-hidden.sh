#!/usr/bin/env bash
set -u
ls /workspace/memory 2>/dev/null && echo 'VISIBLE' || echo 'HIDDEN'
echo '[STAGE_COMPLETE]'
