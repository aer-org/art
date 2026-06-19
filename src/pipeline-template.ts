/**
 * Pipeline template loader & validator.
 *
 * Templates are reusable sub-graphs that get dynamically inserted ("stitched")
 * into the running pipeline when a transition targets a template name. See
 * PLAN_spawn_only_transitions.md for the full model.
 *
 * File layout: <bundleDir>/templates/<name>.json
 * File shape:  { entry?: string, stages: PipelineStage[] }
 *
 * Semantics:
 *   - `next` is always scope-local: it must name a stage inside this template
 *     (or be `null` to end the current template invocation).
 *   - If `template` is also present, the named template is spawned first and
 *     returns to this transition's `next`.
 *   - Cross-template node references are rejected. `template` is the only way
 *     to cross a template boundary.
 */
import fs from 'fs';
import path from 'path';

import { resolveAgentRefs } from './agent-ref.js';
import type { PipelineStage } from './pipeline-types.js';
import {
  TransitionShapeError,
  transitionLabel,
  validateTransitionShape,
} from './transition-shape.js';

export interface PipelineTemplate {
  name: string;
  entry: string;
  stages: PipelineStage[];
}

const TEMPLATE_DIR_NAME = 'templates';
const TEMPLATE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Resolve the absolute path for a template given a bundleDir.
 * Enforces containment — the resolved path must remain inside the templates
 * dir, rejecting traversal (`..`, absolute names).
 */
export function resolveTemplatePath(bundleDir: string, name: string): string {
  if (!TEMPLATE_NAME_PATTERN.test(name)) {
    throw new Error(
      `Template name "${name}" must match ${TEMPLATE_NAME_PATTERN}`,
    );
  }
  const dir = path.join(bundleDir, TEMPLATE_DIR_NAME);
  const resolved = path.resolve(dir, `${name}.json`);
  const rel = path.relative(dir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Template name "${name}" resolves outside templates dir`);
  }
  return resolved;
}

export function loadPipelineTemplate(
  bundleDir: string,
  name: string,
): PipelineTemplate {
  const filepath = resolveTemplatePath(bundleDir, name);
  if (!fs.existsSync(filepath)) {
    throw new Error(`Template "${name}" not found: ${filepath}`);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filepath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Template "${name}": failed to read — ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Template "${name}": invalid JSON — ${(err as Error).message}`,
    );
  }

  const obj = parsed as { stages?: PipelineStage[] };
  if (Array.isArray(obj.stages)) {
    resolveAgentRefs(obj.stages, bundleDir);
  }

  const template = validatePipelineTemplate(parsed, name);

  // Validate + synthesize command stages. Script file must exist under
  // <bundleDir>/scripts/<stage_name>.sh; runtime gets command +
  // scripts: 'ro' mount the same way base stages do.
  const scriptsDir = path.join(bundleDir, 'scripts');
  for (const stage of template.stages) {
    const stageAny = stage as unknown as Record<string, unknown>;
    if (stageAny.kind !== 'command') continue;
    const scriptPath = path.join(scriptsDir, `${stage.name}.sh`);
    if (!fs.existsSync(scriptPath)) {
      throw new Error(
        `Template "${name}": command stage "${stage.name}" requires __art__/scripts/${stage.name}.sh`,
      );
    }
    stage.command = `bash /workspace/scripts/${stage.name}.sh`;
    stage.mounts = { ...stage.mounts, scripts: 'ro' };
  }

  return template;
}

/**
 * Validate a parsed template object and return a normalized PipelineTemplate.
 * Throws on any schema violation. Pure function — no I/O.
 */
export function validatePipelineTemplate(
  input: unknown,
  name: string,
): PipelineTemplate {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`Template "${name}": root must be a JSON object`);
  }
  const obj = input as { entry?: unknown; stages?: unknown };

  if (!Array.isArray(obj.stages) || obj.stages.length === 0) {
    throw new Error(`Template "${name}": "stages" must be a non-empty array`);
  }

  const stages = obj.stages as PipelineStage[];
  const stageNames = new Set<string>();
  for (const stage of stages) {
    validateStageShape(stage, name);
    if (stageNames.has(stage.name)) {
      throw new Error(
        `Template "${name}": duplicate stage name "${stage.name}"`,
      );
    }
    stageNames.add(stage.name);
  }

  // Second pass: scope-check transitions now that all stage names are known.
  // `next` may be a string or an array of strings; both forms must reference
  // stages inside this template (cross-template handoffs go through
  // `template:`).
  for (const stage of stages) {
    for (const t of stage.transitions) {
      const targets =
        typeof t.next === 'string'
          ? [t.next]
          : Array.isArray(t.next)
            ? (t.next as string[])
            : [];
      for (const target of targets) {
        if (stageNames.has(target)) continue;
        const transitionName = transitionLabel(t);
        throw new Error(
          `Template "${name}": stage "${stage.name}" transition "${transitionName}" — "next" must reference a stage inside this template (got "${target}"; use "template" for cross-template handoffs)`,
        );
      }
    }
  }

  let entry: string;
  if (obj.entry !== undefined) {
    if (typeof obj.entry !== 'string' || obj.entry.length === 0) {
      throw new Error(`Template "${name}": "entry" must be a non-empty string`);
    }
    if (!stageNames.has(obj.entry)) {
      throw new Error(
        `Template "${name}": "entry" references unknown stage "${obj.entry}"`,
      );
    }
    entry = obj.entry;
  } else {
    entry = stages[0].name;
  }

  assertTemplateInternalAcyclic(stages, stageNames, name);

  return { name, entry, stages };
}

function validateStageShape(stage: PipelineStage, templateName: string): void {
  if (!stage || typeof stage !== 'object') {
    throw new Error(
      `Template "${templateName}": every stage must be a non-null object`,
    );
  }
  if (typeof stage.name !== 'string' || stage.name.length === 0) {
    throw new Error(
      `Template "${templateName}": every stage requires a non-empty "name"`,
    );
  }
  if (!Array.isArray(stage.transitions)) {
    throw new Error(
      `Template "${templateName}": stage "${stage.name}" missing "transitions" array`,
    );
  }
  const stageAny = stage as unknown as Record<string, unknown>;
  if (stageAny.prompts !== undefined) {
    throw new Error(
      `Template "${templateName}": stage "${stage.name}" uses unsupported "prompts" field; use inline "prompt" or agents/<name>.md`,
    );
  }
  if (stageAny.prompt_append !== undefined) {
    throw new Error(
      `Template "${templateName}": stage "${stage.name}" uses unsupported "prompt_append" field; include the text in "prompt"`,
    );
  }
  if (stageAny.kind !== undefined && stageAny.kind !== 'command') {
    throw new Error(
      `Template "${templateName}": stage "${stage.name}" — "kind" must be "command" or omitted (agent stage)`,
    );
  }
  const isCommandStage = stageAny.kind === 'command';
  if (isCommandStage) {
    if (stage.command !== undefined) {
      throw new Error(
        `Template "${templateName}": stage "${stage.name}" — command stages must not author a "command" field`,
      );
    }
    if (stage.prompt !== undefined) {
      throw new Error(
        `Template "${templateName}": stage "${stage.name}" — command stages must not author a "prompt" field`,
      );
    }
    if ((stage as { agent?: unknown }).agent !== undefined) {
      throw new Error(
        `Template "${templateName}": stage "${stage.name}" — command stages must not author an "agent" ref`,
      );
    }
    const reservedMountKey = Object.keys(stage.mounts ?? {}).find(
      (k) => k === 'scripts' || k.startsWith('scripts:'),
    );
    if (reservedMountKey) {
      throw new Error(
        `Template "${templateName}": stage "${stage.name}" — command stages must not declare a "scripts" mount`,
      );
    }
  }
  if (stage.env) {
    const reservedEnvKey = Object.keys(stage.env).find((k) =>
      k.startsWith('ART_'),
    );
    if (reservedEnvKey) {
      throw new Error(
        `Template "${templateName}": stage "${stage.name}" — env key "${reservedEnvKey}" uses reserved ART_* prefix`,
      );
    }
  }
  if (stage.timeout !== undefined) {
    if (!Number.isFinite(stage.timeout) || stage.timeout <= 0) {
      throw new Error(
        `Template "${templateName}": stage "${stage.name}" has invalid timeout "${String(stage.timeout)}" (must be a positive number of milliseconds)`,
      );
    }
    if (!isCommandStage) {
      throw new Error(
        `Template "${templateName}": stage "${stage.name}" may only use "timeout" on command stages`,
      );
    }
  }
  if (stageAny.fan_in !== undefined) {
    throw new Error(
      `Template "${templateName}": stage "${stage.name}" uses unsupported "fan_in" field; multi-predecessor fan-in is automatic`,
    );
  }
  if (stageAny.join !== undefined) {
    throw new Error(
      `Template "${templateName}": stage "${stage.name}" cannot author runtime "join" metadata`,
    );
  }

  let afterTimeoutTransitions = 0;
  for (const t of stage.transitions) {
    try {
      validateTransitionShape(t, { isCommandStage });
    } catch (err) {
      if (err instanceof TransitionShapeError) {
        throw new Error(
          `Template "${templateName}": stage "${stage.name}" transition "${transitionLabel(t)}" — ${err.message}`,
        );
      }
      throw err;
    }
    if (t.afterTimeout) afterTimeoutTransitions++;
  }
  if (afterTimeoutTransitions > 1) {
    throw new Error(
      `Template "${templateName}": stage "${stage.name}" may only declare one "afterTimeout" transition`,
    );
  }
}

/**
 * Cycle check restricted to transitions whose `next` is a template-internal
 * stage name. External references (base pipeline, other templates) are
 * out-of-scope here — they're validated at stitch-time against the full
 * merged graph.
 */
function assertTemplateInternalAcyclic(
  stages: PipelineStage[],
  stageNames: Set<string>,
  templateName: string,
): void {
  const adj = new Map<string, Set<string>>();
  for (const s of stages) {
    const outgoing = new Set<string>();
    for (const t of s.transitions) {
      const targets =
        typeof t.next === 'string'
          ? [t.next]
          : Array.isArray(t.next)
            ? (t.next as string[])
            : [];
      for (const target of targets) {
        if (stageNames.has(target)) outgoing.add(target);
      }
    }
    adj.set(s.name, outgoing);
  }

  const UNVISITED = 0;
  const ON_STACK = 1;
  const DONE = 2;
  const state = new Map<string, number>();
  for (const s of stages) state.set(s.name, UNVISITED);

  const dfs = (node: string, stack: string[]): void => {
    state.set(node, ON_STACK);
    stack.push(node);
    for (const nxt of adj.get(node) ?? []) {
      const c = state.get(nxt);
      if (c === ON_STACK) {
        const from = stack.indexOf(nxt);
        const cyclePath = [...stack.slice(from), nxt].join(' → ');
        throw new Error(
          `Template "${templateName}": cycle detected — ${cyclePath}`,
        );
      }
      if (c === UNVISITED) dfs(nxt, stack);
    }
    stack.pop();
    state.set(node, DONE);
  };

  for (const s of stages) {
    if (state.get(s.name) === UNVISITED) dfs(s.name, []);
  }
}
