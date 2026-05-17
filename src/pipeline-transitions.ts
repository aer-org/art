import type {
  PipelineStage,
  PipelineTransition,
  TransitionOutcome,
} from './pipeline-types.js';
import { RESERVED_SUBSTITUTION_KEYS, type SubstitutionMap } from './stitch.js';

// --- Stitch directive (result of resolving a transition into stitch inputs) ---

export type StitchDirective =
  | { mode: 'single'; subs?: SubstitutionMap }
  | {
      mode: 'parallel';
      count: number;
      perCopySubs?: SubstitutionMap[];
    };

export interface StageMarkerResult {
  matched: PipelineTransition | null;
  payload: string | null;
}

export function transitionOutcome(
  transition: PipelineTransition,
): TransitionOutcome {
  if (transition.outcome) return transition.outcome;
  if (transition.afterTimeout) return 'error';
  return transition.marker?.includes('ERROR') ? 'error' : 'success';
}

export function transitionDisplayName(transition: PipelineTransition): string {
  if (transition.afterTimeout) return 'afterTimeout';
  return transition.marker ?? 'transition';
}

export function primaryTransition(
  stage: Pick<PipelineStage, 'transitions'>,
): PipelineTransition | undefined {
  return stage.transitions.find((t) => !t.afterTimeout) ?? stage.transitions[0];
}

/**
 * Pure helper: given a matched transition and the payload captured from the
 * agent's marker, return the StitchDirective that performStitch should use.
 * Throws with a descriptive message on any invalid payload shape.
 *
 * Callers must pass `payload` only when the transition has `countFrom:
 * "payload"`; otherwise the argument is ignored. The caller catches thrown
 * errors and surfaces them as STAGE_ERROR outcomes.
 */
export function resolveStitchInputs(
  t: PipelineTransition,
  payload: string | null,
): StitchDirective {
  // Static count path - unchanged from pre-payload behavior.
  if (t.countFrom === undefined) {
    if (t.count !== undefined && t.count > 1) {
      return { mode: 'parallel', count: t.count };
    }
    return { mode: 'single' };
  }

  // Dynamic (payload-driven) path.
  if (payload === null || payload.length === 0) {
    throw new Error(
      'countFrom: "payload" requires the agent to emit a fenced ---PAYLOAD_START---...---PAYLOAD_END--- block after the marker',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    throw new Error(`Payload is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Payload must be a JSON array');
  }
  if (parsed.length === 0) {
    throw new Error('Payload array must be non-empty');
  }
  const wantSubs = t.substitutionsFrom === 'payload';
  const perCopySubs: SubstitutionMap[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const el = parsed[i];
    if (el === null || typeof el !== 'object' || Array.isArray(el)) {
      throw new Error(
        `Payload element [${i}] must be a flat JSON object (got ${el === null ? 'null' : Array.isArray(el) ? 'array' : typeof el})`,
      );
    }
    const subs: SubstitutionMap = {};
    for (const [key, value] of Object.entries(el)) {
      if ((RESERVED_SUBSTITUTION_KEYS as readonly string[]).includes(key)) {
        throw new Error(
          `Payload element [${i}] uses reserved key "${key}" (reserved: ${RESERVED_SUBSTITUTION_KEYS.join(', ')})`,
        );
      }
      if (
        typeof value !== 'string' &&
        typeof value !== 'number' &&
        typeof value !== 'boolean'
      ) {
        throw new Error(
          `Payload element [${i}] field "${key}" must be string/number/boolean (got ${typeof value})`,
        );
      }
      subs[key] = value;
    }
    perCopySubs.push(subs);
  }
  if (perCopySubs.length === 1) {
    return {
      mode: 'single',
      subs: wantSubs ? perCopySubs[0] : undefined,
    };
  }
  return {
    mode: 'parallel',
    count: perCopySubs.length,
    perCopySubs: wantSubs ? perCopySubs : undefined,
  };
}

/**
 * Parse stage markers dynamically from the stage's transitions array.
 *
 * Supported forms (first match wins across transitions):
 *   [MARKER]                                          - no payload
 *   [MARKER: short inline payload]                    - single-line payload
 *   [MARKER]
 *   ---PAYLOAD_START---
 *   free-form multi-line payload (any chars incl. ])
 *   ---PAYLOAD_END---                                 - fenced payload
 *
 * The fenced form is preferred for anything non-trivial. Payload must not
 * contain the literal sentinel `---PAYLOAD_END---` (non-greedy match stops
 * at the first occurrence).
 *
 * Defensive unwrap: if a fenced payload body is *solely* an inline form of
 * the same marker (`[MARKER]` or `[MARKER: value]`), the inner value (or
 * null) is returned. This protects against agents double-wrapping the
 * marker - emitting inline syntax inside the fence - which would otherwise
 * leak literal brackets into downstream dispatchers.
 */
export function parseStageMarkers(
  resultTexts: string[],
  transitions: PipelineTransition[],
): StageMarkerResult {
  const combined = resultTexts.join('\n');
  for (const transition of transitions) {
    if (transition.afterTimeout || !transition.marker) continue;
    const markerName = escapeRegExp(transition.marker);
    // Fenced payload: [MARKER] followed by ---PAYLOAD_START---...---PAYLOAD_END---
    const fencedRegex = new RegExp(
      `\\[${markerName}\\][ \\t]*\\r?\\n[ \\t]*---PAYLOAD_START---[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*---PAYLOAD_END---`,
    );
    const fencedMatch = fencedRegex.exec(combined);
    if (fencedMatch) {
      const payload = fencedMatch[1];
      const unwrapRegex = new RegExp(`^\\[${markerName}(?::\\s*(.+?))?\\]$`);
      const unwrap = unwrapRegex.exec(payload.trim());
      if (unwrap) {
        return { matched: transition, payload: unwrap[1] ?? null };
      }
      return { matched: transition, payload };
    }
    // Inline / no payload: [MARKER] or [MARKER: payload]
    const regex = new RegExp(`\\[${markerName}(?::\\s*(.+?))?\\]`);
    const match = regex.exec(combined);
    if (match) {
      return { matched: transition, payload: match[1] ?? null };
    }
  }
  return { matched: null, payload: null };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
