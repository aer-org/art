#!/usr/bin/env bash
set -euo pipefail
git config --global --add safe.directory /workspace/project
cd /workspace/project
git reset --hard HEAD~1
echo '[STAGE_COMPLETE]'
