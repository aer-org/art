/**
 * Shared per-transition shape validator used by both PIPELINE.json and
 * template (`__art__/templates/*.json`) loaders. Keeps the two surfaces from
 * drifting again: any new rule lives here once.
 *
 * Out of scope (handled at call sites because they depend on container state):
 *   - scope check ("does this `next` name exist in the surrounding pipeline /
 *     template?")
 *   - acyclic check
 *   - file-system checks (script files, agent refs, mcpAccess registry)
 */
import type { PipelineTransition } from './pipeline-types.js';

export class TransitionShapeError extends Error {
  details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'TransitionShapeError';
    this.details = details;
  }
}

export interface TransitionShape {
  /** Resolved transition label — `afterTimeout` or the authored marker. */
  marker: string;
  hasNextString: boolean;
  hasNextArray: boolean;
  /** Empty unless `hasNextArray`. */
  nextArrayEntries: readonly string[];
  hasTemplate: boolean;
}

export function transitionLabel(t: PipelineTransition): string {
  if (t && typeof t === 'object' && t.afterTimeout) return 'afterTimeout';
  return typeof t?.marker === 'string' && t.marker.length > 0
    ? t.marker
    : '<missing-marker>';
}

/**
 * Validate everything about a single transition that does not depend on the
 * surrounding scope. Throws `TransitionShapeError` on the first violation.
 *
 * Error messages use a compact form ("…") so callers can prepend their own
 * prefix ("Transition …" for PIPELINE.json, "Template "X": stage "Y" transition
 * "Z" — …" for template files).
 */
export function validateTransitionShape(
  t: PipelineTransition,
  opts: { isCommandStage: boolean },
): TransitionShape {
  if (!t || typeof t !== 'object') {
    throw new TransitionShapeError('transition must be a non-null object');
  }
  const tAny = t as unknown as Record<string, unknown>;
  const marker = transitionLabel(t);

  if (tAny.retry !== undefined) {
    throw new TransitionShapeError('"retry" is no longer supported', {
      marker,
    });
  }
  if (tAny.next_dynamic !== undefined) {
    throw new TransitionShapeError('"next_dynamic" is no longer supported', {
      marker,
    });
  }
  if (t.afterTimeout !== undefined && typeof t.afterTimeout !== 'boolean') {
    throw new TransitionShapeError('"afterTimeout" must be a boolean', {
      marker,
    });
  }
  if (t.afterTimeout) {
    if (!opts.isCommandStage) {
      throw new TransitionShapeError(
        '"afterTimeout" is only supported for command stages',
      );
    }
    if (t.marker !== undefined) {
      throw new TransitionShapeError(
        '"afterTimeout" cannot be combined with "marker"',
        { marker: t.marker },
      );
    }
    if (t.countFrom !== undefined || t.substitutionsFrom !== undefined) {
      throw new TransitionShapeError(
        '"afterTimeout" does not support payload-driven fanout fields',
        { marker },
      );
    }
  } else if (typeof t.marker !== 'string' || t.marker.length === 0) {
    throw new TransitionShapeError(
      '"marker" is required unless "afterTimeout" is true',
    );
  }

  if (!Object.prototype.hasOwnProperty.call(tAny, 'next')) {
    throw new TransitionShapeError(
      '"next" is required (use null to end the current scope)',
      { marker },
    );
  }

  const isNextArray = Array.isArray(t.next);
  let nextArrayEntries: string[] = [];
  if (isNextArray) {
    const arr = t.next as unknown[];
    if (arr.length === 0) {
      throw new TransitionShapeError(
        '"next" array must contain at least one target (use null to end the current scope)',
        { marker },
      );
    }
    const seen = new Set<string>();
    for (const entry of arr) {
      if (typeof entry !== 'string' || entry.length === 0) {
        throw new TransitionShapeError(
          '"next" array entries must be non-empty strings',
          { marker, next: t.next },
        );
      }
      if (seen.has(entry)) {
        throw new TransitionShapeError(
          `"next" array contains duplicate target "${entry}"`,
          { marker, duplicate: entry },
        );
      }
      seen.add(entry);
    }
    nextArrayEntries = arr as string[];
  } else if (t.next !== null && typeof t.next !== 'string') {
    throw new TransitionShapeError(
      '"next" must be a string, an array of strings, or null',
      { marker, next: t.next },
    );
  }

  const hasNextString = typeof t.next === 'string';
  const hasTemplate = t.template !== undefined;

  if (isNextArray && hasTemplate) {
    throw new TransitionShapeError(
      '"next" array cannot be combined with "template" — template stitch produces its own per-lane downstream',
      { marker },
    );
  }
  if (hasTemplate) {
    if (typeof t.template !== 'string' || t.template.length === 0) {
      throw new TransitionShapeError('"template" must be a non-empty string', {
        marker,
      });
    }
  }
  if (t.count !== undefined) {
    if (!Number.isInteger(t.count) || (t.count as number) < 1) {
      throw new TransitionShapeError('"count" must be a positive integer', {
        marker,
      });
    }
    if (!hasTemplate) {
      throw new TransitionShapeError('"count" requires "template"', { marker });
    }
  }
  if (t.countFrom !== undefined) {
    if (t.countFrom !== 'payload') {
      throw new TransitionShapeError('"countFrom" only accepts "payload"', {
        marker,
      });
    }
    if (!hasTemplate) {
      throw new TransitionShapeError('"countFrom" requires "template"', {
        marker,
      });
    }
    if (t.count !== undefined) {
      throw new TransitionShapeError(
        'must have either "count" or "countFrom", not both',
        { marker },
      );
    }
  }
  if (t.substitutionsFrom !== undefined) {
    if (t.substitutionsFrom !== 'payload') {
      throw new TransitionShapeError(
        '"substitutionsFrom" only accepts "payload"',
        { marker },
      );
    }
    if (t.countFrom !== 'payload') {
      throw new TransitionShapeError(
        '"substitutionsFrom" requires "countFrom: \\"payload\\""',
        { marker },
      );
    }
  }
  if (t.joinPolicy !== undefined) {
    if (
      t.joinPolicy !== 'all_success' &&
      t.joinPolicy !== 'any_success' &&
      t.joinPolicy !== 'all_settled'
    ) {
      throw new TransitionShapeError(
        '"joinPolicy" must be one of "all_success", "any_success", or "all_settled"',
        { marker, joinPolicy: t.joinPolicy },
      );
    }
    if (!hasTemplate) {
      throw new TransitionShapeError('"joinPolicy" requires "template"', {
        marker,
      });
    }
  }
  if (
    t.outcome !== undefined &&
    t.outcome !== 'success' &&
    t.outcome !== 'error'
  ) {
    throw new TransitionShapeError('"outcome" must be "success" or "error"', {
      marker,
      outcome: t.outcome,
    });
  }

  return {
    marker,
    hasNextString,
    hasNextArray: isNextArray,
    nextArrayEntries,
    hasTemplate,
  };
}
