import { describe, it, expect } from 'vitest';
import { generateRunId } from '../../src/run-manifest.js';

describe('generateRunId', () => {
  it('returns run-{timestamp}-{6 hex chars} format', () => {
    const id = generateRunId();
    expect(id).toMatch(/^run-\d+-[0-9a-f]{6}$/);
  });

  it('produces unique IDs on consecutive calls', () => {
    const a = generateRunId();
    const b = generateRunId();
    expect(a).not.toBe(b);
  });
});
