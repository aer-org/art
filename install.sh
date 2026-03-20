#!/usr/bin/env bash
set -euo pipefail

REPO_SSH="git@github.com:aer-org/art.git"
REPO_HTTPS="https://github.com/aer-org/art.git"
BRANCH="dev"
INSTALL_DIR="${ART_INSTALL_DIR:-$HOME/.art}"
BIN_NAME="art"

echo "Installing art CLI..."

# Check prerequisites
if ! command -v node &>/dev/null; then
  echo "Error: Node.js is required (>=20). Install it first." >&2
  exit 1
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Error: Node.js >=20 required (found v$(node -v))" >&2
  exit 1
fi

if ! command -v git &>/dev/null; then
  echo "Error: git is required." >&2
  exit 1
fi

# Pick SSH if key access works, otherwise fall back to HTTPS
SSH_OUTPUT=$(ssh -T git@github.com 2>&1 || true)
if echo "$SSH_OUTPUT" | grep -qi "successfully authenticated"; then
  REPO="$REPO_SSH"
else
  REPO="$REPO_HTTPS"
fi
echo "Using $REPO"

# Clone or update
if [ -d "$INSTALL_DIR" ]; then
  echo "Updating existing installation at $INSTALL_DIR..."
  git -C "$INSTALL_DIR" remote set-url origin "$REPO"
  git -C "$INSTALL_DIR" fetch origin "$BRANCH" --quiet
  git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH" --quiet
else
  echo "Cloning into $INSTALL_DIR..."
  git clone --branch "$BRANCH" --depth 1 --quiet "$REPO" "$INSTALL_DIR"
fi

# Install dependencies (skip optional native modules that may fail)
cd "$INSTALL_DIR"
npm install --omit=dev --ignore-scripts --no-optional 2>/dev/null || npm install --omit=dev --ignore-scripts 2>/dev/null

# Ensure dist/ exists (shipped prebuilt in the repo)
if [ ! -f "dist/cli/index.js" ]; then
  echo "Error: dist/cli/index.js not found. Build may be missing from the branch." >&2
  exit 1
fi

# Make entry point executable
chmod +x dist/cli/index.js

# Create symlink in a directory that's on PATH
BIN_DIR=""
if [ -d "$HOME/.local/bin" ]; then
  BIN_DIR="$HOME/.local/bin"
elif [ -d "$HOME/bin" ]; then
  BIN_DIR="$HOME/bin"
else
  mkdir -p "$HOME/.local/bin"
  BIN_DIR="$HOME/.local/bin"
fi

ln -sf "$INSTALL_DIR/dist/cli/index.js" "$BIN_DIR/$BIN_NAME"

# Check if BIN_DIR is on PATH
if ! echo "$PATH" | tr ':' '\n' | grep -q "^$BIN_DIR$"; then
  SHELL_RC=""
  case "$(basename "$SHELL")" in
    zsh)  SHELL_RC="$HOME/.zshrc" ;;
    bash) SHELL_RC="$HOME/.bashrc" ;;
    *)    SHELL_RC="$HOME/.profile" ;;
  esac
  echo "" >> "$SHELL_RC"
  echo "export PATH=\"$BIN_DIR:\$PATH\"  # art CLI" >> "$SHELL_RC"
  echo ""
  echo "Added $BIN_DIR to PATH in $SHELL_RC"
  echo "Run: source $SHELL_RC"
  echo ""
fi

echo "Done! art CLI installed at $BIN_DIR/$BIN_NAME"
echo ""
echo "Usage:"
echo "  art compose [dir]  Initialize (if needed) and open pipeline editor"
echo "  art run [dir]     Run the agent pipeline"
echo "  art update        Pull latest container images"
