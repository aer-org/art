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
    for (const stage of config.stages) {
      const isCommandStage = typeof stage.command === 'string';
      const stageAny = stage as unknown as Record<string, unknown>;
      if (stageAny.kind !== undefined) {
        return invalid(
          { groupFolder, stage: stage.name, kind: stageAny.kind },
          'Stage "kind" is no longer supported; omit it and set "command" for command stages',
        );
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

      if (!stage.command && !stage.prompt) {
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

      if (stage.join !== undefined) {
        return invalid(
          { groupFolder, stage: stage.name },
          'Runtime "join" metadata cannot be authored in PIPELINE.json',
        );
      }

      let afterTimeoutTransitions = 0;
      for (const t of stage.transitions) {
        const tAny = t as unknown as Record<string, unknown>;
        const transitionName = t.afterTimeout
          ? 'afterTimeout'
          : (t.marker ?? '<missing-marker>');
        if (tAny.retry !== undefined) {
          return invalid(
            { groupFolder, stage: stage.name, marker: transitionName },
            'Transition "retry" is no longer supported',
          );
        }
        if (tAny.next_dynamic !== undefined) {
          return invalid(
            { groupFolder, stage: stage.name, marker: transitionName },
            'Transition "next_dynamic" is no longer supported',
          );
        }
        if (
          t.afterTimeout !== undefined &&
          typeof t.afterTimeout !== 'boolean'
        ) {
          return invalid(
            { groupFolder, stage: stage.name, marker: transitionName },
            'Transition "afterTimeout" must be a boolean',
          );
        }
        if (t.afterTimeout) {
          afterTimeoutTransitions++;
          if (!isCommandStage) {
            return invalid(
              { groupFolder, stage: stage.name },
              'Transition "afterTimeout" is only supported for command stages',
            );
          }
          if (t.marker !== undefined) {
            return invalid(
              { groupFolder, stage: stage.name, marker: t.marker },
              'Transition "afterTimeout" cannot be combined with "marker"',
            );
          }
          if (t.countFrom !== undefined || t.substitutionsFrom !== undefined) {
            return invalid(
              { groupFolder, stage: stage.name, marker: transitionName },
              'Transition "afterTimeout" does not support payload-driven fanout fields',
            );
          }
        } else if (typeof t.marker !== 'string' || t.marker.length === 0) {
          return invalid(
            { groupFolder, stage: stage.name },
            'Transition "marker" is required unless "afterTimeout" is true',
          );
        }
        if (Array.isArray(t.next)) {
          return invalid(
            { groupFolder, stage: stage.name, marker: transitionName },
            'Transition "next" must be a string or null — multi-target arrays are produced only by parallel stitch at runtime',
          );
        }
        if (!Object.prototype.hasOwnProperty.call(tAny, 'next')) {
          return invalid(
            { groupFolder, stage: stage.name, marker: transitionName },
            'Transition "next" is required (use null to end the current scope)',
          );
        }
        if (t.next !== null && typeof t.next !== 'string') {
          return invalid(
            {
              groupFolder,
              stage: stage.name,
              marker: transitionName,
              next: t.next,
            },
            'Transition "next" must be a string or null',
          );
        }
        const hasNextString = typeof t.next === 'string';
        const hasTemplate = t.template !== undefined;
        if (hasTemplate) {
          if (typeof t.template !== 'string' || t.template.length === 0) {
            return invalid(
              { groupFolder, stage: stage.name, marker: transitionName },
              'Transition "template" must be a non-empty string',
            );
          }
        }
        if (t.count !== undefined) {
          if (!Number.isInteger(t.count) || (t.count as number) < 1) {
            return invalid(
              { groupFolder, stage: stage.name, marker: transitionName },
              'Transition "count" must be a positive integer',
            );
          }
          if (!hasTemplate) {
            return invalid(
              { groupFolder, stage: stage.name, marker: transitionName },
              'Transition "count" requires "template"',
            );
          }
        }
        if (t.countFrom !== undefined) {
          if (t.countFrom !== 'payload') {
            return invalid(
              { groupFolder, stage: stage.name, marker: transitionName },
              'Transition "countFrom" only accepts "payload"',
            );
          }
          if (!hasTemplate) {
            return invalid(
              { groupFolder, stage: stage.name, marker: transitionName },
              'Transition "countFrom" requires "template"',
            );
          }
          if (t.count !== undefined) {
            return invalid(
              { groupFolder, stage: stage.name, marker: transitionName },
              'Transition must have either "count" or "countFrom", not both',
            );
          }
        }
        if (t.substitutionsFrom !== undefined) {
          if (t.substitutionsFrom !== 'payload') {
            return invalid(
              { groupFolder, stage: stage.name, marker: transitionName },
              'Transition "substitutionsFrom" only accepts "payload"',
            );
          }
          if (t.countFrom !== 'payload') {
            return invalid(
              { groupFolder, stage: stage.name, marker: transitionName },
              'Transition "substitutionsFrom" requires "countFrom: \\"payload\\""',
            );
          }
        }
        if (t.joinPolicy !== undefined) {
          if (
            t.joinPolicy !== 'all_success' &&
            t.joinPolicy !== 'any_success' &&
            t.joinPolicy !== 'all_settled'
          ) {
            return invalid(
              {
                groupFolder,
                stage: stage.name,
                marker: transitionName,
                joinPolicy: t.joinPolicy,
              },
              'Transition "joinPolicy" must be one of "all_success", "any_success", or "all_settled"',
            );
          }
          if (!hasTemplate) {
            return invalid(
              { groupFolder, stage: stage.name, marker: transitionName },
              'Transition "joinPolicy" requires "template"',
            );
          }
        }
        if (
          t.outcome !== undefined &&
          t.outcome !== 'success' &&
          t.outcome !== 'error'
        ) {
          return invalid(
            {
              groupFolder,
              stage: stage.name,
              marker: transitionName,
              outcome: t.outcome,
            },
            'Transition "outcome" must be "success" or "error"',
          );
        }
        if (hasNextString && !stageNames.has(t.next as string)) {
          return invalid(
            { groupFolder, stage: stage.name, target: t.next },
            'Transition "next" must reference an existing stage in this pipeline',
          );
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
