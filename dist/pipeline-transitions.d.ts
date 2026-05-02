import type { PipelineStage, PipelineTransition, TransitionOutcome } from './pipeline-types.js';
import { type SubstitutionMap } from './stitch.js';
export type StitchDirective = {
    mode: 'single';
    subs?: SubstitutionMap;
} | {
    mode: 'parallel';
    count: number;
    perCopySubs?: SubstitutionMap[];
};
export interface StageMarkerResult {
    matched: PipelineTransition | null;
    payload: string | null;
}
export declare function transitionOutcome(transition: PipelineTransition): TransitionOutcome;
export declare function transitionDisplayName(transition: PipelineTransition): string;
export declare function primaryTransition(stage: Pick<PipelineStage, 'transitions'>): PipelineTransition | undefined;
/**
 * Pure helper: given a matched transition and the payload captured from the
 * agent's marker, return the StitchDirective that performStitch should use.
 * Throws with a descriptive message on any invalid payload shape.
 *
 * Callers must pass `payload` only when the transition has `countFrom:
 * "payload"`; otherwise the argument is ignored. The caller catches thrown
 * errors and surfaces them as STAGE_ERROR outcomes.
 */
export declare function resolveStitchInputs(t: PipelineTransition, payload: string | null): StitchDirective;
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
export declare function parseStageMarkers(resultTexts: string[], transitions: PipelineTransition[]): StageMarkerResult;
//# sourceMappingURL=pipeline-transitions.d.ts.map