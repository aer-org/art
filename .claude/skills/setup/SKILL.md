---
name: setup
description: Run initial AerArt setup. Use when user wants to install dependencies, set up container runtime, or configure Claude authentication. Triggers on "setup", "install", "configure aer-art", or first-time setup requests.
---

# AerArt Setup

Run setup steps automatically. Only pause when user action is required (configuration choices, pasting tokens).

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action. If a dependency is missing, install it. Ask the user for permission when needed, then do the work.

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

## 0. Git & Fork Setup

Check the git remote configuration to ensure the user has a fork and upstream is configured.

Run:
- `git remote -v`

**Case A — `origin` points to `aer-org/art` (user cloned directly):**

The user cloned instead of forking. AskUserQuestion: "You cloned AerArt directly. We recommend forking so you can push your customizations. Would you like to set up a fork?"
- Fork now (recommended) — walk them through it
- Continue without fork — they'll only have local changes

If fork: instruct the user to fork `aer-org/art` on GitHub (they need to do this in their browser), then ask them for their GitHub username. Run:
```bash
git remote rename origin upstream
git remote add origin https://github.com/<their-username>/art.git
git push --force origin main
```
Verify with `git remote -v`.

If continue without fork: add upstream so they can still pull updates:
```bash
git remote add upstream https://github.com/aer-org/art.git
```

**Case B — `origin` points to user's fork, no `upstream` remote:**

Add upstream:
```bash
git remote add upstream https://github.com/aer-org/art.git
```

**Case C — both `origin` (user's fork) and `upstream` (aer-org) exist:**

Already configured. Continue.

**Verify:** `git remote -v` should show `origin` → user's repo, `upstream` → `aer-org/art.git`.

## 1. Bootstrap (Node.js + Dependencies)

Run `bash setup.sh` and parse the status block.

- If NODE_OK=false → Node.js is missing or too old. Use `AskUserQuestion: Would you like me to install Node.js 22?` If confirmed:
  - macOS: `brew install node@22` (if brew available) or install nvm then `nvm install 22`
  - Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`, or nvm
  - After installing Node, re-run `bash setup.sh`
- If DEPS_OK=false → Read `logs/setup.log`. Try: delete `node_modules`, re-run `bash setup.sh`. If native module build fails, install build tools (`xcode-select --install` on macOS, `build-essential` on Linux), then retry.
- Record PLATFORM and IS_WSL for later steps.

## 2. Container Runtime

### 2a. Choose runtime

- PLATFORM=linux → Docker (only option)
- PLATFORM=macos → Use `AskUserQuestion: Docker (cross-platform) or Apple Container (native macOS)?` If Apple Container, run `/convert-to-apple-container` now, then skip to 2c.

### 2b. Install Docker (if needed)

- Docker running → continue to 2c
- Docker installed but not running → start Docker: `open -a Docker` (macOS) or `sudo systemctl start docker` (Linux). Wait 15s, re-check with `docker info`.
- Docker not found → Use `AskUserQuestion: Docker is required for running agents. Would you like me to install it?` If confirmed:
  - macOS: `brew install --cask docker`, then `open -a Docker`
  - Linux: `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`

### 2c. Build container image

Run `./container/build.sh` and verify the image was built successfully.

If build fails:
- Cache issue: `docker builder prune -f` (Docker) or restart builder (Apple Container). Retry.
- Dockerfile syntax or missing files: diagnose from the error and fix.

## 3. Claude Authentication

Check `.env` for `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. If present, confirm with user: keep or reconfigure?

AskUserQuestion: Claude subscription (Pro/Max) vs Anthropic API key?

**Subscription:** Tell user to run `claude setup-token` in another terminal, copy the token, add `CLAUDE_CODE_OAUTH_TOKEN=<token>` to `.env`. Do NOT collect the token in chat.

**API key:** Tell user to add `ANTHROPIC_API_KEY=<key>` to `.env`.

## 4. Verify

Run:
```bash
npm run build
npm test
```

If build or tests fail, diagnose and fix the issue.

Tell user setup is complete. They can now use `art compose` to design pipelines and `art run` to execute them.

## Troubleshooting

**Container agent fails:** Ensure the container runtime is running — `open -a Docker` (macOS Docker), `container system start` (Apple Container), or `sudo systemctl start docker` (Linux). Check container logs in the group's logs directory.
