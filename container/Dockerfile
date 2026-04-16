# AerArt Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

ARG BASE_IMAGE=node:22-slim
FROM ${BASE_IMAGE}

# Install Node.js if not present (custom base images, Debian/Ubuntu only)
RUN which node > /dev/null 2>&1 || \
    (apt-get update && apt-get install -y curl && \
     curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
     apt-get install -y nodejs && \
     rm -rf /var/lib/apt/lists/*)

# Ensure 'node' user exists (node:22-slim has it; custom base images don't)
RUN id node > /dev/null 2>&1 || useradd -m -s /bin/bash node

# Install system dependencies (cross-distro compatible)
COPY install-deps.sh /tmp/install-deps.sh
RUN /tmp/install-deps.sh && rm /tmp/install-deps.sh

ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser, Claude Code, and Codex globally
RUN npm install -g agent-browser @anthropic-ai/claude-code @openai/codex

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/sh\nset -e\ncd /app && node node_modules/typescript/bin/tsc -p tsconfig.json --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to workspace root
WORKDIR /workspace

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
