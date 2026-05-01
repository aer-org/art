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
import type { PipelineStage, PipelineTransition } from './pipeline-runner.js';

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

  return validatePipelineTemplate(parsed, name);
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
  for (const stage of stages) {
    for (const t of stage.transitions) {
      if (typeof t.next === 'string' && !stageNames.has(t.next)) {
        const transitionName = t.afterTimeout
          ? 'afterTimeout'
          : (t.marker ?? '<missing-marker>');
        throw new Error(
          `Template "${name}": stage "${stage.name}" transition "${transitionName}" — "next" must reference a stage inside this template (got "${t.next}"; use "template" for cross-template handoffs)`,
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
  let afterTimeoutTransitions = 0;
  for (const t of stage.transitions) {
    validateTransitionShape(t, stage.name, templateName);
    if (t.afterTimeout) afterTimeoutTransitions++;
  }
  if (
    stage.kind !== undefined &&
    stage.kind !== 'agent' &&
    stage.kind !== 'command'
  ) {
    throw new Error(
      `Template "${templateName}": stage "${stage.name}" has invalid kind "${String(stage.kind)}" (must be "agent" or "command")`,
    );
  }
  if (stage.timeout !== undefined) {
    if (!Number.isFinite(stage.timeout) || stage.timeout <= 0) {
      throw new Error(
        `Template "${templateName}": stage "${stage.name}" has invalid timeout "${String(stage.timeout)}" (must be a positive number of milliseconds)`,
      );
    }
    if (!stage.command) {
      throw new Error(
        `Template "${templateName}": stage "${stage.name}" may only use "timeout" on command stages`,
      );
    }
  }
  if (stage.fan_in !== undefined && stage.fan_in !== 'all') {
    throw new Error(
      `Template "${templateName}": stage "${stage.name}" has invalid fan_in "${String(stage.fan_in)}" (must be "all")`,
    );
  }
  if (stage.join !== undefined) {
    throw new Error(
      `Template "${templateName}": stage "${stage.name}" cannot author runtime "join" metadata`,
    );
  }
  if (afterTimeoutTransitions > 0 && !stage.command) {
    throw new Error(
      `Template "${templateName}": stage "${stage.name}" may only use "afterTimeout" transitions on command stages`,
    );
  }
  if (afterTimeoutTransitions > 1) {
    throw new Error(
      `Template "${templateName}": stage "${stage.name}" may only declare one "afterTimeout" transition`,
    );
  }
}

function validateTransitionShape(
  t: PipelineTransition,
  stageName: string,
  templateName: string,
): void {
  if (!t || typeof t !== 'object') {
    throw new Error(
      `Template "${templateName}": stage "${stageName}" has a non-object transition`,
    );
  }
  const tAny = t as unknown as Record<string, unknown>;
  const transitionName = t.afterTimeout
    ? 'afterTimeout'
    : (t.marker ?? '<missing-marker>');
  if (tAny.retry !== undefined) {
    throw new Error(
      `Template "${templateName}": stage "${stageName}" transition "${transitionName}" — "retry" is no longer supported`,
    );
  }
  if (tAny.next_dynamic !== undefined) {
    throw new Error(
      `Template "${templateName}": stage "${stageName}" transition "${transitionName}" — "next_dynamic" is no longer supported`,
    );
  }
  if (t.afterTimeout !== undefined && typeof t.afterTimeout !== 'boolean') {
    throw new Error(
      `Template "${templateName}": stage "${stageName}" transition "${transitionName}" — "afterTimeout" must be a boolean`,
    );
  }
  if (t.afterTimeout) {
    if (t.marker !== undefined) {
      throw new Error(
        `Template "${templateName}": stage "${stageName}" transition "${transitionName}" — "afterTimeout" cannot be combined with "marker"`,
      );
    }
  } else if (typeof t.marker !== 'string' || t.marker.length === 0) {
    throw new Error(
      `Template "${templateName}": stage "${stageName}" transition "${transitionName}" — "marker" is required unless "afterTimeout" is true`,
    );
  }
  if (t.next !== undefined && t.next !== null && typeof t.next !== 'string') {
    throw new Error(
      `Template "${templateName}": stage "${stageName}" transition "${transitionName}" — "next" must be a string or null (authored arrays are not allowed)`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(tAny, 'next')) {
    throw new Error(
      `Template "${templateName}": stage "${stageName}" transition "${transitionName}" — "next" is required (use null to end the current template invocation)`,
    );
  }
  const hasNext = t.next === null || typeof t.next === 'string';
  const hasTemplate = t.template !== undefined;
  if (!hasNext) {
    throw new Error(
      `Template "${templateName}": stage "${stageName}" transition "${transitionName}" — "next" must be a string or null`,
    );
  }
  if (hasTemplate) {
    if (typeof t.template !== 'string' || t.template.length === 0) {
      throw new Error(
        `Template "${templateName}": stage "${stageName}" transition "${transitionName}" — "template" must be a non-empty string`,
      );
    }
  }
  if (tAny.count !== undefined) {
    const c = tAny.count;
    if (typeof c !== 'number' || !Number.isInteger(c) || c < 1) {
      throw new Error(
        `Template "${templateName}": stage "${stageName}" transition "${transitionName}" — "count" must be a positive integer`,
      );
    }
    if (!hasTemplate) {
      throw new Error(
        `Template "${templateName}": stage "${stageName}" transition "${transitionName}" — "count" requires "template"`,
      );
    }
  }
  if (t.countFrom !== undefined) {
    if (t.countFrom !== 'payload') {
      throw new Error(
        `Template "${templateName}": stage "${stageName}" transition "${transitionName}" — "countFrom" only accepts "payload"`,
      );
    }
    if (!hasTemplate) {
      throw new Error(
        `Template "${templateName}": stage "${stageName}" transition "${transitionName}" — "countFrom" requires "template"`,
      );
    }
    if (tAny.count !== undefined) {
      throw new Error(
        `Template "${templateName}": stage "${stageName}" transition "${transitionName}" — must have either "count" or "countFrom", not both`,
      );
    }
  }
  if (t.substitutionsFrom !== undefined) {
    if (t.substitutionsFrom !== 'payload') {
      throw new Error(
        `Template "${templateName}": stage "${stageName}" transition "${transitionName}" — "substitutionsFrom" only accepts "payload"`,
      );
    }
    if (t.countFrom !== 'payload') {
      throw new Error(
        `Template "${templateName}": stage "${stageName}" transition "${transitionName}" — "substitutionsFrom" requires "countFrom: \\"payload\\""`,
      );
    }
    if (t.afterTimeout) {
      throw new Error(
        `Template "${templateName}": stage "${stageName}" transition "${transitionName}" — "afterTimeout" does not support payload-driven fanout fields`,
      );
    }
  }
  if (t.joinPolicy !== undefined) {
    if (
      t.joinPolicy !== 'all_success' &&
      t.joinPolicy !== 'any_success' &&
      t.joinPolicy !== 'all_settled'
    ) {
      throw new Error(
        `Template "${templateName}": stage "${stageName}" transition "${transitionName}" — "joinPolicy" must be one of "all_success", "any_success", or "all_settled"`,
      );
    }
    if (!hasTemplate) {
      throw new Error(
        `Template "${templateName}": stage "${stageName}" transition "${transitionName}" — "joinPolicy" requires "template"`,
      );
    }
  }
  if (
    t.outcome !== undefined &&
    t.outcome !== 'success' &&
    t.outcome !== 'error'
  ) {
    throw new Error(
      `Template "${templateName}": stage "${stageName}" transition "${transitionName}" — "outcome" must be "success" or "error"`,
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
      if (typeof t.next === 'string' && stageNames.has(t.next)) {
        outgoing.add(t.next);
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
