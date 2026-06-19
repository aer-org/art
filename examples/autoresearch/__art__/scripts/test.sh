#!/usr/bin/env bash
set -uo pipefail
apt-get update -qq
apt-get install -y -qq curl > /dev/null
curl -LsSf https://astral.sh/uv/install.sh | sh > /dev/null 2>&1
export PATH="$HOME/.local/bin:$PATH"
mkdir -p /workspace/cache/uv-python /workspace/cache/uv-cache
ln -sfn /workspace/cache/uv-cache /root/.cache/uv
ln -sfn /workspace/cache/uv-python /root/.local/share/uv/python
cd /workspace/project
UV_PROJECT_ENVIRONMENT=/workspace/venv uv run src/prepare.py
UV_PROJECT_ENVIRONMENT=/workspace/venv uv run src/train.py > /workspace/results/run.log 2>&1
grep '^val_bpb:\|^peak_rss_mb:' /workspace/results/run.log > /workspace/results/metrics.txt 2>/dev/null || true
echo '[STAGE_COMPLETE]'
