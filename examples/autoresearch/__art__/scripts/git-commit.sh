#!/usr/bin/env bash
set -euo pipefail
git config --global --add safe.directory /workspace/project
git config --global user.email 'art-agent@local'
git config --global user.name 'AerArt Agent'
cd /workspace/project
git add -A
msg="$(cat /workspace/msg/commit-msg.txt 2>/dev/null || echo 'experiment iteration')"
git commit --allow-empty -m "$msg"
echo '[STAGE_COMPLETE]'
