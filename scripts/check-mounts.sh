#!/usr/bin/env bash
# Check mount permissions of all running art pipeline containers
# against PIPELINE.json expectations.
#
# Usage: ./scripts/check-mounts.sh [project-dir]
#   project-dir defaults to current directory

set -uo pipefail

PROJECT_DIR="${1:-.}"
PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
ART_DIR="$PROJECT_DIR/__art__"
PIPELINE_JSON="$ART_DIR/PIPELINE.json"

if [ ! -f "$PIPELINE_JSON" ]; then
  echo "ERROR: $PIPELINE_JSON not found" >&2
  exit 1
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

PASS=0
FAIL=0
WARN=0

verify_policy() {
  local container="$1" label="$2" cpath="$3" expected="$4"

  local exists
  exists=$(docker exec "$container" sh -c "[ -e '$cpath' ] && echo yes || echo no" 2>/dev/null || echo "error")

  if [ "$expected" = "disabled" ]; then
    if [ "$exists" = "no" ]; then
      echo -e "  ${GREEN}OK${RESET}  $label = disabled  ${DIM}(not present)${RESET}"
      ((PASS++))
    elif docker exec "$container" sh -c "[ ! -d '$cpath' ]" 2>/dev/null; then
      # Non-directory (file, /dev/null, etc.): disabled means empty or special
      local size
      size=$(docker exec "$container" sh -c "stat -c %s '$cpath' 2>/dev/null || echo '?'" 2>/dev/null)
      if [ "$size" = "0" ]; then
        echo -e "  ${GREEN}OK${RESET}  $label = disabled  ${DIM}(/dev/null)${RESET}"
        ((PASS++))
      else
        echo -e "  ${RED}FAIL${RESET}  $label = disabled  but file has ${size} bytes!"
        ((FAIL++))
      fi
    else
      # Directory: disabled means empty dir
      local count
      count=$(docker exec "$container" sh -c "ls -A '$cpath' 2>/dev/null | wc -l" 2>/dev/null || echo "?")
      if [ "$count" = "0" ]; then
        echo -e "  ${GREEN}OK${RESET}  $label = disabled  ${DIM}(empty shadow)${RESET}"
        ((PASS++))
      else
        echo -e "  ${RED}FAIL${RESET}  $label = disabled  but has $count entries!"
        ((FAIL++))
      fi
    fi
    return
  fi

  if [ "$exists" = "no" ]; then
    echo -e "  ${RED}FAIL${RESET}  $label = $expected  but path missing: $cpath"
    ((FAIL++))
    return
  fi
  if [ "$exists" = "error" ]; then
    echo -e "  ${YELLOW}WARN${RESET}  $label  cannot exec into container"
    ((WARN++))
    return
  fi

  local can_write
  if docker exec "$container" sh -c "[ -f '$cpath' ]" 2>/dev/null; then
    # Path is a file — test by touching it (updates mtime if writable)
    can_write=$(docker exec "$container" sh -c "touch '$cpath' 2>/dev/null && echo yes || echo no" 2>/dev/null || echo "error")
  else
    # Path is a directory — test by creating a temp file inside
    local test_file="$cpath/.art-mount-check-$$"
    can_write=$(docker exec "$container" sh -c "touch '$test_file' 2>/dev/null && rm -f '$test_file' && echo yes || echo no" 2>/dev/null || echo "error")
  fi

  if [ "$expected" = "rw" ]; then
    if [ "$can_write" = "yes" ]; then
      echo -e "  ${GREEN}OK${RESET}  $label = rw"
      ((PASS++))
    else
      echo -e "  ${RED}FAIL${RESET}  $label expected rw, but read-only!"
      ((FAIL++))
    fi
  elif [ "$expected" = "ro" ]; then
    if [ "$can_write" = "no" ]; then
      echo -e "  ${GREEN}OK${RESET}  $label = ro"
      ((PASS++))
    else
      echo -e "  ${RED}FAIL${RESET}  $label expected ro, but writable!"
      ((FAIL++))
    fi
  else
    echo -e "  ${YELLOW}WARN${RESET}  $label = $expected (unknown policy)"
    ((WARN++))
  fi
}

# Get all running art containers
mapfile -t CONTAINERS < <(docker ps --filter "name=aer-art-" --format '{{.Names}}' 2>/dev/null)

if [ ${#CONTAINERS[@]} -eq 0 ]; then
  echo -e "${YELLOW}No running art containers found.${RESET}"
  exit 0
fi

echo -e "${BOLD}Checking mount permissions for project: ${PROJECT_DIR}${RESET}"
echo ""

for CONTAINER in "${CONTAINERS[@]}"; do
  STAGE=$(echo "$CONTAINER" | sed -n 's/.*--pipeline-\([^-]*\)-[0-9]*$/\1/p')
  if [ -z "$STAGE" ]; then
    echo -e "${YELLOW}SKIP${RESET} $CONTAINER (not a pipeline stage container)"
    continue
  fi

  echo -e "${BOLD}${CYAN}=== Stage: $STAGE ===${RESET}  ($CONTAINER)"

  # Parse stage config: GROUP/PROJECT_ROOT/PROJECT_SUB lines
  STAGE_CONFIG=$(python3 -c "
import json
with open('$PIPELINE_JSON') as f:
    pipeline = json.load(f)
for stage in pipeline['stages']:
    if stage['name'] != '$STAGE':
        continue
    mounts = stage.get('mounts', {})
    for key, policy in mounts.items():
        if key == 'project' or key.startswith('project:'):
            continue
        p = 'disabled' if policy is None else (policy or 'disabled')
        print(f'GROUP\t{key}\t{p}')
    proj = mounts.get('project', 'ro')
    proj_eff = 'disabled' if proj is None else proj
    print(f'PROJECT_ROOT\t{proj_eff}')
    for key, policy in mounts.items():
        if not key.startswith('project:'):
            continue
        sub = key[len('project:'):]
        p = 'disabled' if policy is None else policy
        print(f'PROJECT_SUB\t{sub}\t{p}')
    break
" 2>/dev/null || true)

  if [ -z "$STAGE_CONFIG" ]; then
    echo -e "  ${YELLOW}WARN: Stage '$STAGE' not found in PIPELINE.json${RESET}"
    ((WARN++))
    echo ""
    continue
  fi

  # --- Check stage mounts ---
  echo -e "  ${DIM}── /workspace ──${RESET}"
  mapfile -t GROUP_LINES < <(echo "$STAGE_CONFIG" | grep '^GROUP' || true)
  for line in "${GROUP_LINES[@]}"; do
    [ -z "$line" ] && continue
    key=$(echo "$line" | cut -f2)
    policy=$(echo "$line" | cut -f3)
    verify_policy "$CONTAINER" "$key" "/workspace/$key" "$policy"
  done

  # --- Check project ---
  PROJECT_ROOT_POLICY=$(echo "$STAGE_CONFIG" | grep '^PROJECT_ROOT' | cut -f2)

  echo -e "  ${DIM}── /workspace/project ──${RESET}"

  if [ -z "$PROJECT_ROOT_POLICY" ] || [ "$PROJECT_ROOT_POLICY" = "disabled" ]; then
    verify_policy "$CONTAINER" "project" "/workspace/project" "disabled"
    echo ""
    continue
  fi

  verify_policy "$CONTAINER" "project (root)" "/workspace/project" "$PROJECT_ROOT_POLICY"

  # Collect project:* overrides
  declare -A SUB_OVERRIDES=()
  mapfile -t SUB_LINES < <(echo "$STAGE_CONFIG" | grep '^PROJECT_SUB' || true)
  for line in "${SUB_LINES[@]}"; do
    [ -z "$line" ] && continue
    sub=$(echo "$line" | cut -f2)
    policy=$(echo "$line" | cut -f3)
    SUB_OVERRIDES["$sub"]="$policy"
  done

  # Check every entry under /workspace/project/
  CHILDREN=$(docker exec "$CONTAINER" sh -c "ls -1 /workspace/project/ 2>/dev/null" 2>/dev/null || true)
  ART_DIR_NAME=$(basename "$ART_DIR")

  for CHILD in $CHILDREN; do
    if [ "$CHILD" = "$ART_DIR_NAME" ]; then
      verify_policy "$CONTAINER" "project:$CHILD" "/workspace/project/$CHILD" "disabled"
      continue
    fi

    if [ -n "${SUB_OVERRIDES[$CHILD]+x}" ]; then
      EXPECTED="${SUB_OVERRIDES[$CHILD]}"
    else
      EXPECTED="$PROJECT_ROOT_POLICY"
    fi

    verify_policy "$CONTAINER" "project:$CHILD" "/workspace/project/$CHILD" "$EXPECTED"
  done

  # Check overrides for paths not in ls
  for SUB in "${!SUB_OVERRIDES[@]}"; do
    FOUND=0
    for CHILD in $CHILDREN; do
      if [ "$CHILD" = "$SUB" ]; then FOUND=1; break; fi
    done
    if [ "$FOUND" = "0" ]; then
      verify_policy "$CONTAINER" "project:$SUB" "/workspace/project/$SUB" "${SUB_OVERRIDES[$SUB]}"
    fi
  done

  unset SUB_OVERRIDES
  echo ""
done

# Summary
echo -e "${BOLD}--- Summary ---${RESET}"
echo -e "  ${GREEN}Pass: $PASS${RESET}  ${RED}Fail: $FAIL${RESET}  ${YELLOW}Warn: $WARN${RESET}"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
