import fs from 'fs';
import path from 'path';
import { resolveAgentRefs } from './agent-ref.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { loadMcpRegistry, resolveStageMcpServers, } from './mcp-registry.js';
import { assertConfigAcyclic } from './stitch.js';
/**
 * Load and validate a pipeline config.
 * @param pipelinePath - Absolute path to a pipeline JSON file. When provided,
 *   groupFolder/groupDir are ignored and the file is loaded directly.
 * Bundle-relative assets (agents/, templates/) resolve from the directory
 * containing the pipeline file (bundleDir).
 * Returns null if the file doesn't exist.
 */
export function loadPipelineConfig(groupFolder, groupDir, pipelinePath) {
    const dir = groupDir ?? resolveGroupFolderPath(groupFolder);
    if (!pipelinePath) {
        pipelinePath = path.join(dir, 'PIPELINE.json');
    }
    const bundleDir = path.dirname(pipelinePath);
    if (!fs.existsSync(pipelinePath)) {
        return null;
    }
    try {
        const raw = fs.readFileSync(pipelinePath, 'utf-8');
        const config = JSON.parse(raw);
        let mcpRegistry;
        // Resolve agent refs (agents/*.md) relative to bundle dir
        if (Array.isArray(config.stages)) {
            resolveAgentRefs(config.stages, bundleDir);
        }
        // Basic validation
        if (!Array.isArray(config.stages) || config.stages.length === 0) {
            logger.warn({ groupFolder }, 'PIPELINE.json has no stages');
            return null;
        }
        // Validate stage names and transitions
        const stageNames = new Set(config.stages.map((s) => s.name));
        for (const stage of config.stages) {
            const isCommandStage = typeof stage.command === 'string';
            if (stage.kind !== undefined &&
                stage.kind !== 'agent' &&
                stage.kind !== 'command') {
                logger.error({ groupFolder, stage: stage.name, kind: stage.kind }, 'Invalid stage kind (must be "agent" or "command")');
                return null;
            }
            const stageAny = stage;
            if (stageAny.prompts !== undefined) {
                logger.error({ groupFolder, stage: stage.name }, 'Stage "prompts" is no longer supported; use inline "prompt" or agents/<name>.md');
                return null;
            }
            if (stageAny.prompt_append !== undefined) {
                logger.error({ groupFolder, stage: stage.name }, 'Stage "prompt_append" is no longer supported; include the text in "prompt"');
                return null;
            }
            if (stage.prompt !== undefined && typeof stage.prompt !== 'string') {
                logger.error({ groupFolder, stage: stage.name, prompt: stage.prompt }, 'Invalid prompt field (must be a string)');
                return null;
            }
            if (stage.timeout !== undefined) {
                if (!Number.isFinite(stage.timeout) || stage.timeout <= 0) {
                    logger.error({ groupFolder, stage: stage.name, timeout: stage.timeout }, 'Invalid timeout field (must be a positive number of milliseconds)');
                    return null;
                }
                if (!isCommandStage) {
                    logger.error({ groupFolder, stage: stage.name }, 'Stage "timeout" is only supported for command stages');
                    return null;
                }
            }
            if (stage.mcpAccess !== undefined &&
                (!Array.isArray(stage.mcpAccess) ||
                    stage.mcpAccess.some((ref) => typeof ref !== 'string'))) {
                logger.error({ groupFolder, stage: stage.name, mcpAccess: stage.mcpAccess }, 'Invalid mcpAccess field (must be an array of registry ref strings)');
                return null;
            }
            if (!stage.command && !stage.prompt) {
                logger.error({ groupFolder, stage: stage.name }, 'Agent stage must define prompt');
                return null;
            }
            if (isCommandStage && stage.mcpAccess && stage.mcpAccess.length > 0) {
                logger.error({ groupFolder, stage: stage.name }, 'Command stages cannot declare mcpAccess');
                return null;
            }
            if (stage.mcpAccess && stage.mcpAccess.length > 0) {
                try {
                    mcpRegistry ??= loadMcpRegistry();
                    resolveStageMcpServers(stage.mcpAccess, { registry: mcpRegistry });
                }
                catch (err) {
                    logger.error({ groupFolder, stage: stage.name, err }, 'Invalid mcpAccess configuration');
                    return null;
                }
            }
            if (stage.fan_in !== undefined && stage.fan_in !== 'all') {
                logger.error({ groupFolder, stage: stage.name, fan_in: stage.fan_in }, 'Invalid fan_in value (must be "all")');
                return null;
            }
            if (stage.join !== undefined) {
                logger.error({ groupFolder, stage: stage.name }, 'Runtime "join" metadata cannot be authored in PIPELINE.json');
                return null;
            }
            let afterTimeoutTransitions = 0;
            for (const t of stage.transitions) {
                const tAny = t;
                const transitionName = t.afterTimeout
                    ? 'afterTimeout'
                    : (t.marker ?? '<missing-marker>');
                if (tAny.retry !== undefined) {
                    logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition "retry" is no longer supported');
                    return null;
                }
                if (tAny.next_dynamic !== undefined) {
                    logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition "next_dynamic" is no longer supported');
                    return null;
                }
                if (t.afterTimeout !== undefined &&
                    typeof t.afterTimeout !== 'boolean') {
                    logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition "afterTimeout" must be a boolean');
                    return null;
                }
                if (t.afterTimeout) {
                    afterTimeoutTransitions++;
                    if (!isCommandStage) {
                        logger.error({ groupFolder, stage: stage.name }, 'Transition "afterTimeout" is only supported for command stages');
                        return null;
                    }
                    if (t.marker !== undefined) {
                        logger.error({ groupFolder, stage: stage.name, marker: t.marker }, 'Transition "afterTimeout" cannot be combined with "marker"');
                        return null;
                    }
                    if (t.countFrom !== undefined || t.substitutionsFrom !== undefined) {
                        logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition "afterTimeout" does not support payload-driven fanout fields');
                        return null;
                    }
                }
                else if (typeof t.marker !== 'string' || t.marker.length === 0) {
                    logger.error({ groupFolder, stage: stage.name }, 'Transition "marker" is required unless "afterTimeout" is true');
                    return null;
                }
                if (Array.isArray(t.next)) {
                    logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition "next" must be a string or null — multi-target arrays are produced only by parallel stitch at runtime');
                    return null;
                }
                if (!Object.prototype.hasOwnProperty.call(tAny, 'next')) {
                    logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition "next" is required (use null to end the current scope)');
                    return null;
                }
                if (t.next !== null && typeof t.next !== 'string') {
                    logger.error({
                        groupFolder,
                        stage: stage.name,
                        marker: transitionName,
                        next: t.next,
                    }, 'Transition "next" must be a string or null');
                    return null;
                }
                const hasNextString = typeof t.next === 'string';
                const hasTemplate = t.template !== undefined;
                if (hasTemplate) {
                    if (typeof t.template !== 'string' || t.template.length === 0) {
                        logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition "template" must be a non-empty string');
                        return null;
                    }
                }
                if (t.count !== undefined) {
                    if (!Number.isInteger(t.count) || t.count < 1) {
                        logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition "count" must be a positive integer');
                        return null;
                    }
                    if (!hasTemplate) {
                        logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition "count" requires "template"');
                        return null;
                    }
                }
                if (t.countFrom !== undefined) {
                    if (t.countFrom !== 'payload') {
                        logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition "countFrom" only accepts "payload"');
                        return null;
                    }
                    if (!hasTemplate) {
                        logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition "countFrom" requires "template"');
                        return null;
                    }
                    if (t.count !== undefined) {
                        logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition must have either "count" or "countFrom", not both');
                        return null;
                    }
                }
                if (t.substitutionsFrom !== undefined) {
                    if (t.substitutionsFrom !== 'payload') {
                        logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition "substitutionsFrom" only accepts "payload"');
                        return null;
                    }
                    if (t.countFrom !== 'payload') {
                        logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition "substitutionsFrom" requires "countFrom: \\"payload\\""');
                        return null;
                    }
                }
                if (t.joinPolicy !== undefined) {
                    if (t.joinPolicy !== 'all_success' &&
                        t.joinPolicy !== 'any_success' &&
                        t.joinPolicy !== 'all_settled') {
                        logger.error({
                            groupFolder,
                            stage: stage.name,
                            marker: transitionName,
                            joinPolicy: t.joinPolicy,
                        }, 'Transition "joinPolicy" must be one of "all_success", "any_success", or "all_settled"');
                        return null;
                    }
                    if (!hasTemplate) {
                        logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition "joinPolicy" requires "template"');
                        return null;
                    }
                }
                if (t.outcome !== undefined &&
                    t.outcome !== 'success' &&
                    t.outcome !== 'error') {
                    logger.error({
                        groupFolder,
                        stage: stage.name,
                        marker: transitionName,
                        outcome: t.outcome,
                    }, 'Transition "outcome" must be "success" or "error"');
                    return null;
                }
                if (hasNextString && !stageNames.has(t.next)) {
                    logger.error({ groupFolder, stage: stage.name, target: t.next }, 'Transition "next" must reference an existing stage in this pipeline');
                    return null;
                }
            }
            if (afterTimeoutTransitions > 1) {
                logger.error({ groupFolder, stage: stage.name }, 'At most one transition may declare "afterTimeout: true"');
                return null;
            }
        }
        try {
            assertConfigAcyclic(config);
        }
        catch (err) {
            logger.error({ groupFolder, err: err.message }, 'PIPELINE.json contains a cycle — pipelines must be DAGs');
            return null;
        }
        return config;
    }
    catch (err) {
        logger.error({ groupFolder, err }, 'Failed to parse PIPELINE.json');
        return null;
    }
}
//# sourceMappingURL=pipeline-config.js.map