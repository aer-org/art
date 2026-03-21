/**
 * Container Runner for AerArt
 * Spawns agent execution in containers and handles IPC
 */
import { exec, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { CONTAINER_IMAGE, CONTAINER_MAX_OUTPUT_SIZE, CONTAINER_TIMEOUT, getCredentialProxyPort, getProjectRoot, DATA_DIR, GROUPS_DIR, IDLE_TIMEOUT, TIMEZONE, } from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { cleanupContainer, getRuntime, hostGatewayArgs, prepareContainer, readonlyMountArgs, stopContainer, writableMountArgs, } from './container-runtime.js';
import { detectAuthMode } from './credential-proxy.js';
import { validateAdditionalMounts } from './mount-security.js';
// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---AER_ART_OUTPUT_START---';
const OUTPUT_END_MARKER = '---AER_ART_OUTPUT_END---';
function buildVolumeMounts(group, isMain) {
    const mounts = [];
    const projectRoot = process.cwd();
    const groupDir = resolveGroupFolderPath(group.folder);
    if (isMain) {
        // Main gets the project root read-only. Writable paths the agent needs
        // (IPC, .claude/) are mounted separately below.
        // Read-only prevents the agent from modifying host application code
        // (src/, dist/, package.json, etc.) which would bypass the sandbox
        // entirely on next restart.
        mounts.push({
            hostPath: projectRoot,
            containerPath: '/workspace/project',
            readonly: true,
        });
        // Shadow .env so the agent cannot read secrets from the mounted project root.
        // Credentials are injected by the credential proxy, never exposed to containers.
        const envFile = path.join(projectRoot, '.env');
        if (fs.existsSync(envFile)) {
            mounts.push({
                hostPath: '/dev/null',
                containerPath: '/workspace/project/.env',
                readonly: true,
            });
        }
    }
    // Global memory directory (read-only, shared across all groups)
    if (!isMain) {
        const globalDir = path.join(GROUPS_DIR, 'global');
        if (fs.existsSync(globalDir)) {
            mounts.push({
                hostPath: globalDir,
                containerPath: '/workspace/global',
                readonly: true,
            });
        }
    }
    // Per-group Claude sessions directory (isolated from other groups)
    // Each group gets their own .claude/ to prevent cross-group session access
    const groupSessionsDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');
    fs.mkdirSync(groupSessionsDir, { recursive: true });
    const settingsFile = path.join(groupSessionsDir, 'settings.json');
    if (!fs.existsSync(settingsFile)) {
        fs.writeFileSync(settingsFile, JSON.stringify({
            env: {
                // Enable agent swarms (subagent orchestration)
                // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
                CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
                // Load CLAUDE.md from additional mounted directories
                // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
                CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
                // Enable Claude's memory feature (persists user preferences between sessions)
                // https://code.claude.com/docs/en/memory#manage-auto-memory
                CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
            },
        }, null, 2) + '\n');
    }
    // Sync skills from container/skills/ into each group's .claude/skills/
    const skillsSrc = path.join(getProjectRoot(), 'container', 'skills');
    const skillsDst = path.join(groupSessionsDir, 'skills');
    if (fs.existsSync(skillsSrc)) {
        for (const skillDir of fs.readdirSync(skillsSrc)) {
            const srcDir = path.join(skillsSrc, skillDir);
            if (!fs.statSync(srcDir).isDirectory())
                continue;
            const dstDir = path.join(skillsDst, skillDir);
            fs.cpSync(srcDir, dstDir, { recursive: true });
        }
    }
    mounts.push({
        hostPath: groupSessionsDir,
        containerPath: group.containerConfig?.runAsRoot
            ? '/root/.claude'
            : '/home/node/.claude',
        readonly: false,
    });
    // Per-group IPC namespace: each group gets its own IPC directory
    // This prevents cross-group privilege escalation via IPC
    const groupIpcDir = resolveGroupIpcPath(group.folder);
    fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
    fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
    mounts.push({
        hostPath: groupIpcDir,
        containerPath: '/workspace/ipc',
        readonly: false,
    });
    // Copy agent-runner source into a per-group writable location so agents
    // can customize it (add tools, change behavior) without affecting other
    // groups. Recompiled on container startup via entrypoint.sh.
    const agentRunnerSrc = path.join(getProjectRoot(), 'container', 'agent-runner', 'src');
    const groupAgentRunnerDir = path.join(DATA_DIR, 'sessions', group.folder, 'agent-runner-src');
    if (fs.existsSync(agentRunnerSrc)) {
        // Always re-sync from package source so updates take effect.
        // Agents can still customize at runtime; changes are overwritten on next run.
        fs.mkdirSync(groupAgentRunnerDir, { recursive: true });
        fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
        mounts.push({
            hostPath: groupAgentRunnerDir,
            containerPath: '/app/src',
            readonly: false,
        });
    }
    // udocker F1 (Fakechroot) can't resolve symlinked binaries like npx,
    // and doesn't support stdin piping. Mount a patched entrypoint that:
    // 1. Calls tsc via node directly (no npx symlink)
    // 2. Skips stdin cat — agent-runner reads input from IPC file instead
    if (getRuntime().kind === 'udocker') {
        const patchedEntrypoint = path.join(DATA_DIR, 'sessions', group.folder, 'entrypoint.sh');
        fs.writeFileSync(patchedEntrypoint, '#!/bin/sh\nset -e\n' +
            'cd /app && node node_modules/typescript/bin/tsc --outDir /tmp/dist 2>&1 >&2\n' +
            'ln -s /app/node_modules /tmp/dist/node_modules\n' +
            'chmod -R a-w /tmp/dist\n' +
            'node /tmp/dist/index.js\n', { mode: 0o755 });
        mounts.push({
            hostPath: patchedEntrypoint,
            containerPath: '/app/entrypoint.sh',
            readonly: true,
        });
    }
    // Additional mounts validated against external allowlist (tamper-proof from containers)
    if (group.containerConfig?.additionalMounts) {
        const validatedMounts = validateAdditionalMounts(group.containerConfig.additionalMounts, group.name, isMain);
        mounts.push(...validatedMounts);
    }
    // Internal mounts: host-generated, appended directly (bypass mount-security)
    if (group.containerConfig?.internalMounts) {
        mounts.push(...group.containerConfig.internalMounts);
    }
    return mounts;
}
export function buildContainerArgs(mounts, containerName, devices = [], runAsRoot = false, image, entrypoint, runId) {
    const rt = getRuntime();
    const args = ['run'];
    if (rt.capabilities.supportsStdin)
        args.push('-i');
    if (rt.capabilities.supportsAutoRemove)
        args.push('--rm');
    if (rt.capabilities.supportsNaming)
        args.push('--name', containerName);
    // Label for run-ID-based cleanup
    if (runId && rt.capabilities.supportsPsFilter) {
        args.push('--label', `art-run-id=${runId}`);
    }
    // Pass host timezone so container's local time matches the user's
    args.push('-e', `TZ=${TIMEZONE}`);
    // Route API traffic through the credential proxy (containers never see real secrets)
    args.push('-e', `ANTHROPIC_BASE_URL=http://${rt.hostGateway}:${getCredentialProxyPort()}`);
    // Mirror the host's auth method with a placeholder value.
    // API key mode: SDK sends x-api-key, proxy replaces with real key.
    // OAuth mode:   SDK exchanges placeholder token for temp API key,
    //               proxy injects real OAuth token on that exchange request.
    const authMode = detectAuthMode();
    if (authMode === 'api-key') {
        args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
    }
    else {
        args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
    }
    // Pass host git identity so containers can commit without extra config
    try {
        const gitName = execSync('git config --global user.name', {
            encoding: 'utf-8',
        }).trim();
        const gitEmail = execSync('git config --global user.email', {
            encoding: 'utf-8',
        }).trim();
        if (gitName)
            args.push('-e', `GIT_AUTHOR_NAME=${gitName}`, '-e', `GIT_COMMITTER_NAME=${gitName}`);
        if (gitEmail)
            args.push('-e', `GIT_AUTHOR_EMAIL=${gitEmail}`, '-e', `GIT_COMMITTER_EMAIL=${gitEmail}`);
    }
    catch {
        // No global git config — containers will need their own
    }
    // Runtime-specific args for host gateway resolution
    args.push(...hostGatewayArgs());
    // Podman rootless: --userns=keep-id handles UID mapping, skip --user
    if (rt.kind === 'podman' && rt.rootless) {
        args.push('--userns=keep-id');
    }
    else if (rt.capabilities.supportsUser) {
        // Run as host user so bind-mounted files are accessible.
        // Skip when running as root (uid 0), as the container's node user (uid 1000),
        // or when getuid is unavailable (native Windows without WSL).
        if (runAsRoot) {
            args.push('--user', '0:0');
            args.push('-e', 'HOME=/root');
        }
        else {
            const hostUid = process.getuid?.();
            const hostGid = process.getgid?.();
            if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
                args.push('--user', `${hostUid}:${hostGid}`);
                args.push('-e', 'HOME=/home/node');
            }
        }
    }
    for (const mount of mounts) {
        if (mount.readonly) {
            args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
        }
        else {
            args.push(...writableMountArgs(mount.hostPath, mount.containerPath));
        }
    }
    for (const device of devices) {
        if (device === '/dev/bus/usb') {
            if (!rt.capabilities.supportsDeviceCgroupRule) {
                logger.warn({ device, runtime: rt.kind }, 'USB device passthrough not supported, skipping');
                continue;
            }
            args.push('-v', '/dev/bus/usb:/dev/bus/usb');
            args.push('--device-cgroup-rule', 'c 189:* rmw');
            continue;
        }
        if (!rt.capabilities.supportsDevices) {
            logger.warn({ device, runtime: rt.kind }, 'Device passthrough not supported, skipping');
            continue;
        }
        args.push('--device', `${device}:${device}`);
    }
    if (entrypoint) {
        args.push('--entrypoint', entrypoint);
    }
    if (rt.kind === 'udocker') {
        // udocker run uses container name (created beforehand), not image name
        args.push(containerName);
    }
    else {
        args.push(image || CONTAINER_IMAGE);
    }
    return args;
}
export async function runContainerAgent(group, input, onProcess, onOutput, logStream) {
    const startTime = Date.now();
    const groupDir = resolveGroupFolderPath(group.folder);
    fs.mkdirSync(groupDir, { recursive: true });
    const mounts = buildVolumeMounts(group, input.isMain);
    const devices = group.containerConfig?.additionalDevices || [];
    const runAsRoot = group.containerConfig?.runAsRoot === true;
    const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
    const containerName = `aer-art-${safeName}-${Date.now()}`;
    const image = group.containerConfig?.image || CONTAINER_IMAGE;
    const containerArgs = buildContainerArgs(mounts, containerName, devices, runAsRoot, image, undefined, input.runId);
    logger.debug({
        group: group.name,
        containerName,
        mounts: mounts.map((m) => `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`),
        devices,
        runAsRoot,
        containerArgs: containerArgs.join(' '),
    }, 'Container mount configuration');
    logger.info({
        group: group.name,
        containerName,
        mountCount: mounts.length,
        isMain: input.isMain,
    }, 'Spawning container agent');
    const logsDir = path.join(groupDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    return new Promise((resolve) => {
        const rt = getRuntime();
        // udocker: create a named container with F1 (Fakechroot) mode before running
        prepareContainer(image, containerName);
        const container = spawn(rt.bin, containerArgs, {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        onProcess(container, containerName);
        let stdout = '';
        let stderr = '';
        let stdoutTruncated = false;
        let stderrTruncated = false;
        // Stream container output to external log if provided
        if (logStream) {
            logStream.write(`\n=== Stage: ${group.name} ===\n` +
                `Started: ${new Date().toISOString()}\n` +
                `Container: ${containerName}\n\n`);
        }
        if (rt.capabilities.supportsStdin) {
            container.stdin.write(JSON.stringify(input));
            container.stdin.end();
        }
        else {
            // Write input to IPC file for runtimes without stdin support (udocker)
            const inputFilePath = path.join(resolveGroupIpcPath(group.folder), '_initial_input.json');
            fs.writeFileSync(inputFilePath, JSON.stringify(input));
        }
        // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
        let parseBuffer = '';
        let newSessionId;
        let outputChain = Promise.resolve();
        container.stdout.on('data', (data) => {
            const chunk = data.toString();
            if (logStream)
                logStream.write(chunk);
            // Always accumulate for logging
            if (!stdoutTruncated) {
                const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
                if (chunk.length > remaining) {
                    stdout += chunk.slice(0, remaining);
                    stdoutTruncated = true;
                    logger.warn({ group: group.name, size: stdout.length }, 'Container stdout truncated due to size limit');
                }
                else {
                    stdout += chunk;
                }
            }
            // Stream-parse for output markers
            if (onOutput) {
                parseBuffer += chunk;
                let startIdx;
                while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
                    const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
                    if (endIdx === -1)
                        break; // Incomplete pair, wait for more data
                    const jsonStr = parseBuffer
                        .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
                        .trim();
                    parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);
                    try {
                        const parsed = JSON.parse(jsonStr);
                        if (parsed.newSessionId) {
                            newSessionId = parsed.newSessionId;
                        }
                        hadStreamingOutput = true;
                        // Activity detected — reset the hard timeout
                        resetTimeout();
                        // Call onOutput for all markers (including null results)
                        // so idle timers start even for "silent" query completions.
                        outputChain = outputChain.then(() => onOutput(parsed));
                    }
                    catch (err) {
                        logger.warn({ group: group.name, error: err }, 'Failed to parse streamed output chunk');
                    }
                }
            }
        });
        container.stderr.on('data', (data) => {
            const chunk = data.toString();
            if (logStream)
                logStream.write(`[stderr] ${chunk}`);
            const lines = chunk.trim().split('\n');
            for (const line of lines) {
                if (line)
                    logger.debug({ container: group.folder }, line);
            }
            // Don't reset timeout on stderr — SDK writes debug logs continuously.
            // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
            if (stderrTruncated)
                return;
            const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
            if (chunk.length > remaining) {
                stderr += chunk.slice(0, remaining);
                stderrTruncated = true;
                logger.warn({ group: group.name, size: stderr.length }, 'Container stderr truncated due to size limit');
            }
            else {
                stderr += chunk;
            }
        });
        let timedOut = false;
        let hadStreamingOutput = false;
        const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
        // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
        // graceful _close sentinel has time to trigger before the hard kill fires.
        const timeoutMs = Math.min(Math.max(configTimeout, IDLE_TIMEOUT + 30_000), 2_147_483_647);
        const killOnTimeout = () => {
            timedOut = true;
            logger.error({ group: group.name, containerName }, 'Container timeout, stopping gracefully');
            if (rt.capabilities.supportsNaming) {
                exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
                    if (err) {
                        logger.warn({ group: group.name, containerName, err }, 'Graceful stop failed, force killing');
                        container.kill('SIGKILL');
                    }
                });
            }
            else {
                // Runtime without --name (udocker): kill the process directly
                container.kill('SIGTERM');
                let exited = false;
                container.once('exit', () => {
                    exited = true;
                });
                setTimeout(() => {
                    if (!exited)
                        container.kill('SIGKILL');
                }, 15000);
            }
        };
        let timeout = setTimeout(killOnTimeout, timeoutMs);
        // Reset the timeout whenever there's activity (streaming output)
        const resetTimeout = () => {
            clearTimeout(timeout);
            timeout = setTimeout(killOnTimeout, timeoutMs);
        };
        container.on('close', (code) => {
            clearTimeout(timeout);
            // udocker: remove the ephemeral container
            cleanupContainer(containerName);
            const duration = Date.now() - startTime;
            if (logStream) {
                logStream.write(`\n=== Stage ${group.name} exited: code=${code} duration=${duration}ms ===\n`);
            }
            if (timedOut) {
                const ts = new Date().toISOString().replace(/[:.]/g, '-');
                const timeoutLog = path.join(logsDir, `container-${ts}.log`);
                fs.writeFileSync(timeoutLog, [
                    `=== Container Run Log (TIMEOUT) ===`,
                    `Timestamp: ${new Date().toISOString()}`,
                    `Group: ${group.name}`,
                    `Container: ${containerName}`,
                    `Duration: ${duration}ms`,
                    `Exit Code: ${code}`,
                    `Had Streaming Output: ${hadStreamingOutput}`,
                ].join('\n'));
                // Timeout after output = idle cleanup, not failure.
                // The agent already sent its response; this is just the
                // container being reaped after the idle period expired.
                if (hadStreamingOutput) {
                    logger.info({ group: group.name, containerName, duration, code }, 'Container timed out after output (idle cleanup)');
                    outputChain.then(() => {
                        resolve({
                            status: 'success',
                            result: null,
                            newSessionId,
                        });
                    });
                    return;
                }
                logger.error({ group: group.name, containerName, duration, code }, 'Container timed out with no output');
                resolve({
                    status: 'error',
                    result: null,
                    error: `Container timed out after ${configTimeout}ms`,
                });
                return;
            }
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const logFile = path.join(logsDir, `container-${timestamp}.log`);
            const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';
            const logLines = [
                `=== Container Run Log ===`,
                `Timestamp: ${new Date().toISOString()}`,
                `Group: ${group.name}`,
                `IsMain: ${input.isMain}`,
                `Duration: ${duration}ms`,
                `Exit Code: ${code}`,
                `Stdout Truncated: ${stdoutTruncated}`,
                `Stderr Truncated: ${stderrTruncated}`,
                ``,
            ];
            const isError = code !== 0;
            if (isVerbose || isError) {
                logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``, `=== Container Args ===`, containerArgs.join(' '), ``, `=== Mounts ===`, mounts
                    .map((m) => `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
                    .join('\n'), ``, `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`, stderr, ``, `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`, stdout);
            }
            else {
                logLines.push(`=== Input Summary ===`, `Prompt length: ${input.prompt.length} chars`, `Session ID: ${input.sessionId || 'new'}`, ``, `=== Mounts ===`, mounts
                    .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
                    .join('\n'), ``);
            }
            fs.writeFileSync(logFile, logLines.join('\n'));
            logger.debug({ logFile, verbose: isVerbose }, 'Container log written');
            if (code !== 0) {
                logger.error({
                    group: group.name,
                    code,
                    duration,
                    stderr,
                    stdout,
                    logFile,
                }, 'Container exited with error');
                resolve({
                    status: 'error',
                    result: null,
                    error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
                });
                return;
            }
            // Streaming mode: wait for output chain to settle, return completion marker
            if (onOutput) {
                outputChain.then(() => {
                    logger.info({ group: group.name, duration, newSessionId }, 'Container completed (streaming mode)');
                    resolve({
                        status: 'success',
                        result: null,
                        newSessionId,
                    });
                });
                return;
            }
            // Legacy mode: parse the last output marker pair from accumulated stdout
            try {
                // Extract JSON between sentinel markers for robust parsing
                const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
                const endIdx = stdout.indexOf(OUTPUT_END_MARKER);
                let jsonLine;
                if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
                    jsonLine = stdout
                        .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
                        .trim();
                }
                else {
                    // Fallback: last non-empty line (backwards compatibility)
                    const lines = stdout.trim().split('\n');
                    jsonLine = lines[lines.length - 1];
                }
                const output = JSON.parse(jsonLine);
                logger.info({
                    group: group.name,
                    duration,
                    status: output.status,
                    hasResult: !!output.result,
                }, 'Container completed');
                resolve(output);
            }
            catch (err) {
                logger.error({
                    group: group.name,
                    stdout,
                    stderr,
                    error: err,
                }, 'Failed to parse container output');
                resolve({
                    status: 'error',
                    result: null,
                    error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
                });
            }
        });
        container.on('error', (err) => {
            clearTimeout(timeout);
            logger.error({ group: group.name, containerName, error: err }, 'Container spawn error');
            resolve({
                status: 'error',
                result: null,
                error: `Container spawn error: ${err.message}`,
            });
        });
    });
}
//# sourceMappingURL=container-runner.js.map