#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# 1. Backend deps
[ -d node_modules ] || npm install

# 2. Frontend deps + build (rebuild if web/dist is missing or older than any source file)
[ -d web/node_modules ] || (cd web && npm install)
needs_build=0
if [ ! -d web/dist ]; then
  needs_build=1
elif [ -n "$(find web/src web/index.html -newer web/dist -type f -print -quit 2>/dev/null)" ]; then
  needs_build=1
fi
[ "$needs_build" -eq 0 ] || (cd web && npm run build)

# 3. Resolve port
PORT="${AER_ART_APP_PORT:-4000}"
echo "Starting AerArt debug UI on http://localhost:${PORT}"

# 4. Best-effort browser open
( sleep 1 && {
    if command -v xdg-open >/dev/null 2>&1; then xdg-open "http://localhost:${PORT}";
    elif command -v open >/dev/null 2>&1; then open "http://localhost:${PORT}";
    fi
  } >/dev/null 2>&1 ) &

# 5. Foreground backend (Node 22+ strips TS natively)
exec node --experimental-strip-types server/index.ts
