import fs from 'fs';
import path from 'path';

import { resolveAgentRefs } from './agent-ref.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  loadMcpRegistry,
  resolveStageMcpServers,
  type ExternalMcpRegistry,
} from './mcp-registry.js';
import type { PipelineConfig } from './pipeline-types.js';
import { assertConfigAcyclic } from './stitch.js';
import {
  TransitionShapeError,
  transitionLabel,
  validateTransitionShape,
} from './transition-shape.js';

export type PipelineConfigLoadErrorKind = 'missing' | 'invalid' | 'parse';

export interface PipelineConfigLoadError {
  kind: PipelineConfigLoadErrorKind;
  path: string;
  message: string;
  details?: Record<string, unknown>;
}

let lastPipelineConfigLoadError: PipelineConfigLoadError | null = null;

function setPipelineConfigLoadError(
  error: PipelineConfigLoadError,
): PipelineConfig | null {
  lastPipelineConfigLoadError = error;
  return null;
}

export function getLastPipelineConfigLoadError(): PipelineConfigLoadError | null {
  return lastPipelineConfigLoadError;
}

function formatDetailValue(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function summarizeErrorDetails(details?: Record<string, unknown>): string {
  if (!details) return '';

  const parts: string[] = [];
  for (const key of [
    'stage',
    'marker',
    'target',
    'kind',
    'fan_in',
    'prompt',
    'timeout',
    'mcpAccess',
    'next',
    'template',
    'count',
    'countFrom',
    'substitutionsFrom',
    'joinPolicy',
    'outcome',
    'error',
  ]) {
    if (Object.prototype.hasOwnProperty.call(details, key)) {
      parts.push(`${key}: ${formatDetailValue(details[key])}`);
    }
  }

  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

export function formatPipelineConfigLoadError(
  error: PipelineConfigLoadError | null,
  fallbackName = 'PIPELINE.json',
): string {
  if (!error) return `No ${fallbackName} found`;
  if (error.kind === 'missing') return `No ${error.path} found`;

  const label = error.path || fallbackName;
  return `${label} is invalid: ${error.message}${summarizeErrorDetails(
    error.details,
  )}`;
}

/**
 * Load and validate a pipeline config.
 * @param pipelinePath - Absolute path to a pipeline JSON file. When provided,
 *   groupFolder/groupDir are ignored and the file is loaded directly.
 * Bundle-relative assets (agents/, templates/) resolve from the directory
 * containing the pipeline file (bundleDir).
 * Returns null if the file doesn't exist or fails validation.
 * Call getLastPipelineConfigLoadError() for the reason.
 */
export function loadPipelineConfig(
  groupFolder: string,
  groupDir?: string,
  pipelinePath?: string,
): PipelineConfig | null {
  lastPipelineConfigLoadError = null;
  const dir = groupDir ?? resolveGroupFolderPath(groupFolder);
  if (!pipelinePath) {
    pipelinePath = path.join(dir, 'PIPELINE.json');
  }

  const bundleDir = path.dirname(pipelinePath);

  if (!fs.existsSync(pipelinePath)) {
    return setPipelineConfigLoadError({
      kind: 'missing',
      path: pipelinePath,
      message: 'PIPELINE.json was not found',
    });
  }

  const invalid = (
    details: Record<string, unknown>,
    message: string,
  ): PipelineConfig | null => {
    logger.error(details, message);
    return setPipelineConfigLoadError({
      kind: 'invalid',
      path: pipelinePath,
      message,
      details,
    });
  };

  const invalidWarning = (
    details: Record<string, unknown>,
    message: string,
  ): PipelineConfig | null => {
    logger.warn(details, message);
    return setPipelineConfigLoadError({
      kind: 'invalid',
      path: pipelinePath,
      message,
      details,
    });
  };

  try {
    const raw = fs.readFileSync(pipelinePath, 'utf-8');
    const config: PipelineConfig = JSON.parse(raw);
    let mcpRegistry: ExternalMcpRegistry | undefined;

    // Resolve agent refs (agents/*.md) relative to bundle dir
    if (Array.isArray(config.stages)) {
      resolveAgentRefs(config.stages, bundleDir);
    }

    // Basic validation
    if (!Array.isArray(config.stages) || config.stages.length === 0) {
      return invalidWarning({ groupFolder }, 'PIPELINE.json has no stages');
    }

    // Validate stage names and transitions
    const stageNames = new Set(config.stages.map((s) => s.name));
    const scriptsDir = path.join(bundleDir, 'scripts');
    for (const stage of config.stages) {
      const stageAny = stage as unknown as Record<string, unknown>;
      const declaredKind = stageAny.kind;
      // `kind: 'command'` is the canonical marker for command stages.
      // Any other authored value is rejected; absent kind = agent stage.
      if (declaredKind !== undefined && declaredKind !== 'command') {
        return invalid(
          { groupFolder, stage: stage.name, kind: declaredKind },
          'Stage "kind" must be "command" or omitted (agent stage)',
        );
      }
      const isCommandStage = declaredKind === 'command';

      if (isCommandStage) {
        if (stage.command !== undefined) {
          return invalid(
            { groupFolder, stage: stage.name },
            'Command stages must not author a "command" field — runtime invokes __art__/scripts/<stage_name>.sh',
          );
        }
        if (stage.prompt !== undefined) {
          return invalid(
            { groupFolder, stage: stage.name },
            'Command stages must not author a "prompt" field',
          );
        }
        if ((stage as { agent?: unknown }).agent !== undefined) {
          return invalid(
            { groupFolder, stage: stage.name },
            'Command stages must not author an "agent" ref',
          );
        }
        const reservedMountKey = Object.keys(stage.mounts ?? {}).find(
          (k) => k === 'scripts' || k.startsWith('scripts:'),
        );
        if (reservedMountKey) {
          return invalid(
            { groupFolder, stage: stage.name, mountKey: reservedMountKey },
            'Command stages must not declare a "scripts" mount — runtime injects it read-only',
          );
        }
        const scriptPath = path.join(scriptsDir, `${stage.name}.sh`);
        if (!fs.existsSync(scriptPath)) {
          return invalid(
            { groupFolder, stage: stage.name, scriptPath },
            `Command stage "${stage.name}" requires __art__/scripts/${stage.name}.sh`,
          );
        }
      }

      if (stage.env) {
        const reservedEnvKey = Object.keys(stage.env).find((k) =>
          k.startsWith('ART_'),
        );
        if (reservedEnvKey) {
          return invalid(
            { groupFolder, stage: stage.name, envKey: reservedEnvKey },
            `Stage "env" key "${reservedEnvKey}" uses reserved ART_* prefix (runtime-injected)`,
          );
        }
      }

      if (stageAny.prompts !== undefined) {
        return invalid(
          { groupFolder, stage: stage.name },
          'Stage "prompts" is no longer supported; use inline "prompt" or agents/<name>.md',
        );
      }

      if (stageAny.prompt_append !== undefined) {
        return invalid(
          { groupFolder, stage: stage.name },
          'Stage "prompt_append" is no longer supported; include the text in "prompt"',
        );
      }

      if (stage.prompt !== undefined && typeof stage.prompt !== 'string') {
        return invalid(
          { groupFolder, stage: stage.name, prompt: stage.prompt },
          'Invalid prompt field (must be a string)',
        );
      }
      if (stage.timeout !== undefined) {
        if (!Number.isFinite(stage.timeout) || stage.timeout <= 0) {
          return invalid(
            { groupFolder, stage: stage.name, timeout: stage.timeout },
            'Invalid timeout field (must be a positive number of milliseconds)',
          );
        }
        if (!isCommandStage) {
          return invalid(
            { groupFolder, stage: stage.name },
            'Stage "timeout" is only supported for command stages',
          );
        }
      }

      if (
        stage.mcpAccess !== undefined &&
        (!Array.isArray(stage.mcpAccess) ||
          stage.mcpAccess.some((ref) => typeof ref !== 'string'))
      ) {
        return invalid(
          { groupFolder, stage: stage.name, mcpAccess: stage.mcpAccess },
          'Invalid mcpAccess field (must be an array of registry ref strings)',
        );
      }

      if (!isCommandStage && !stage.prompt) {
        return invalid(
          { groupFolder, stage: stage.name },
          'Agent stage must define prompt',
        );
      }

      if (isCommandStage && stage.mcpAccess && stage.mcpAccess.length > 0) {
        return invalid(
          { groupFolder, stage: stage.name },
          'Command stages cannot declare mcpAccess',
        );
      }

      if (stage.mcpAccess && stage.mcpAccess.length > 0) {
        try {
          mcpRegistry ??= loadMcpRegistry();
          resolveStageMcpServers(stage.mcpAccess, { registry: mcpRegistry });
        } catch (err) {
          return invalid(
            { groupFolder, stage: stage.name, err },
            'Invalid mcpAccess configuration',
          );
        }
      }

      if (stageAny.fan_in !== undefined) {
        return invalid(
          { groupFolder, stage: stage.name, fan_in: stageAny.fan_in },
          'Stage "fan_in" is no longer supported; multi-predecessor fan-in is automatic',
        );
      }

      if (stageAny.join !== undefined) {
        return invalid(
          { groupFolder, stage: stage.name },
          'Runtime "join" metadata cannot be authored in PIPELINE.json',
        );
      }

      let afterTimeoutTransitions = 0;
      for (const t of stage.transitions) {
        let shape;
        try {
          shape = validateTransitionShape(t, { isCommandStage });
        } catch (err) {
          if (err instanceof TransitionShapeError) {
            return invalid(
              {
                groupFolder,
                stage: stage.name,
                marker: transitionLabel(t),
                ...err.details,
              },
              `Transition ${err.message}`,
            );
          }
          throw err;
        }
        if (t.afterTimeout) afterTimeoutTransitions++;
        if (shape.hasNextString && !stageNames.has(t.next as string)) {
          return invalid(
            { groupFolder, stage: stage.name, target: t.next },
            'Transition "next" must reference an existing stage in this pipeline',
          );
        }
        if (shape.hasNextArray) {
          for (const entry of shape.nextArrayEntries) {
            if (!stageNames.has(entry)) {
              return invalid(
                { groupFolder, stage: stage.name, target: entry },
                `Transition "next" array entry "${entry}" does not reference an existing stage in this pipeline`,
              );
            }
          }
        }
      }
      if (afterTimeoutTransitions > 1) {
        return invalid(
          { groupFolder, stage: stage.name },
          'At most one transition may declare "afterTimeout: true"',
        );
      }
    }

    try {
      assertConfigAcyclic(config);
    } catch (err) {
      return invalid(
        { groupFolder, err: (err as Error).message },
        'PIPELINE.json contains a cycle — pipelines must be DAGs',
      );
    }

    // After validation: synthesize the runtime shape for command stages.
    // Authors write `kind: 'command'` + script file; loader fills in the
    // `command` field and the read-only scripts mount so the runtime sees
    // the same internal shape as before.
    for (const stage of config.stages) {
      const stageAny = stage as unknown as Record<string, unknown>;
      if (stageAny.kind !== 'command') continue;
      stage.command = `bash /workspace/scripts/${stage.name}.sh`;
      stage.mounts = { ...stage.mounts, scripts: 'ro' };
    }

    return config;
  } catch (err) {
    logger.error({ groupFolder, err }, 'Failed to parse PIPELINE.json');
    const errorMessage = err instanceof Error ? err.message : String(err);
    return setPipelineConfigLoadError({
      kind: 'parse',
      path: pipelinePath,
      message: 'Failed to parse PIPELINE.json',
      details: { groupFolder, error: errorMessage },
    });
  }
}
