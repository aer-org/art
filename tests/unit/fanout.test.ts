import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  applyFanoutSubstitutions,
  assertFanoutDepthAllowed,
  deriveChildScopeId,
  loadFanoutTemplate,
  MAX_FANOUT_RECURSION_DEPTH,
  parseFanoutPayload,
  readFanoutDepth,
  withConcurrency,
} from '../../src/fanout.js';
import type { PipelineConfig } from '../../src/pipeline-runner.js';

describe('parseFanoutPayload', () => {
  it('parses a valid JSON array of flat objects', () => {
    const out = parseFanoutPayload(
      '[{"name":"a","n":1},{"name":"b","flag":true}]',
      'fan',
    );
    expect(out).toEqual([
      { name: 'a', n: 1 },
      { name: 'b', flag: true },
    ]);
  });

  it('accepts an empty array', () => {
    expect(parseFanoutPayload('[]', 'fan')).toEqual([]);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseFanoutPayload('{not json', 'fan')).toThrow(
      /not valid JSON/,
    );
  });

  it('rejects non-array top level', () => {
    expect(() => parseFanoutPayload('{"x":1}', 'fan')).toThrow(
      /must be a JSON array/,
    );
  });

  it('rejects non-object element', () => {
    expect(() => parseFanoutPayload('[1,2,3]', 'fan')).toThrow(
      /must be an object/,
    );
  });

  it('rejects nested object/array values (flat-only)', () => {
    expect(() => parseFanoutPayload('[{"x":{"nested":1}}]', 'fan')).toThrow(
      /must be string \| number \| boolean/,
    );
    expect(() => parseFanoutPayload('[{"x":[1,2]}]', 'fan')).toThrow(
      /must be string \| number \| boolean/,
    );
  });
});

describe('applyFanoutSubstitutions', () => {
  const template: PipelineConfig = {
    stages: [
      {
        name: 'build',
        prompt: 'Build {{name}} on port {{port}}',
        mounts: {},
        transitions: [{ marker: 'DONE', next: null }],
      },
    ],
  };

  it('substitutes {{key}} in allowed fields', () => {
    const out = applyFanoutSubstitutions(
      template,
      { name: 'mymod', port: 8080 },
      ['prompt'],
      'fan',
    );
    expect(out.stages[0].prompt).toBe('Build mymod on port 8080');
  });

  it('leaves missing keys intact', () => {
    const out = applyFanoutSubstitutions(
      template,
      { name: 'x' },
      ['prompt'],
      'fan',
    );
    expect(out.stages[0].prompt).toContain('{{port}}');
  });

  it('does not touch fields outside the allowlist', () => {
    const tmpl: PipelineConfig = {
      stages: [
        {
          name: 's',
          prompt: 'x',
          mounts: { '{{key}}': 'ro' as const },
          transitions: [{ marker: 'DONE', next: null }],
        },
      ],
    };
    const out = applyFanoutSubstitutions(
      tmpl,
      { key: 'src' },
      ['prompt'],
      'fan',
    );
    // "mounts" not in allowlist → key not substituted
    expect(Object.keys(out.stages[0].mounts)).toEqual(['{{key}}']);
  });

  it('descends into mounts object when in allowlist', () => {
    const tmpl: PipelineConfig = {
      stages: [
        {
          name: 's',
          prompt: 'x',
          mounts: { 'project:{{sub}}': 'rw' as const },
          transitions: [{ marker: 'DONE', next: null }],
        },
      ],
    };
    const out = applyFanoutSubstitutions(
      tmpl,
      { sub: 'src/mod-a' },
      ['mounts'],
      'fan',
    );
    expect(Object.keys(out.stages[0].mounts)).toEqual(['project:src/mod-a']);
  });
});

describe('deriveChildScopeId', () => {
  it('returns deterministic 7-char scope', () => {
    const a = deriveChildScopeId(undefined, 'fanout', 0);
    const b = deriveChildScopeId(undefined, 'fanout', 0);
    expect(a).toEqual(b);
    expect(a).toMatch(/^f[0-9a-f]{6}$/);
  });

  it('differs by index, parent, and parent scope', () => {
    const a = deriveChildScopeId(undefined, 'fanout', 0);
    const b = deriveChildScopeId(undefined, 'fanout', 1);
    const c = deriveChildScopeId(undefined, 'other', 0);
    const d = deriveChildScopeId('fa12', 'fanout', 0);
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});

describe('withConcurrency', () => {
  it('runs unbounded when max is undefined', async () => {
    let active = 0;
    let peak = 0;
    const task = () => async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    };
    await withConcurrency(
      undefined,
      Array.from({ length: 5 }, () => task()),
    );
    expect(peak).toBe(5);
  });

  it('caps concurrent tasks at max', async () => {
    let active = 0;
    let peak = 0;
    const task = () => async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    };
    await withConcurrency(
      2,
      Array.from({ length: 6 }, () => task()),
    );
    expect(peak).toBe(2);
  });

  it('rethrows the first error after all tasks settle', async () => {
    const completed: number[] = [];
    const tasks = [
      async () => {
        completed.push(0);
        return 0;
      },
      async () => {
        throw new Error('boom-1');
      },
      async () => {
        completed.push(2);
        return 2;
      },
    ];
    await expect(withConcurrency(2, tasks)).rejects.toThrow(/boom-1/);
    // All non-throwing tasks should have completed before the reject.
    expect(completed.sort()).toEqual([0, 2]);
  });
});

describe('fanout depth tracking', () => {
  const prev = process.env.ART_FANOUT_DEPTH;
  afterEach(() => {
    if (prev === undefined) delete process.env.ART_FANOUT_DEPTH;
    else process.env.ART_FANOUT_DEPTH = prev;
  });

  it('reads 0 when env var unset', () => {
    delete process.env.ART_FANOUT_DEPTH;
    expect(readFanoutDepth()).toBe(0);
  });

  it('allows depth up to MAX_FANOUT_RECURSION_DEPTH', () => {
    delete process.env.ART_FANOUT_DEPTH;
    expect(assertFanoutDepthAllowed('s')).toBe(1);
    process.env.ART_FANOUT_DEPTH = '1';
    expect(assertFanoutDepthAllowed('s')).toBe(MAX_FANOUT_RECURSION_DEPTH);
  });

  it('rejects depth past MAX_FANOUT_RECURSION_DEPTH', () => {
    process.env.ART_FANOUT_DEPTH = String(MAX_FANOUT_RECURSION_DEPTH);
    expect(() => assertFanoutDepthAllowed('s')).toThrow(
      /recursion depth .* exceeds max/,
    );
  });
});

describe('loadFanoutTemplate', () => {
  it('loads a valid template relative to groupDir', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-fanout-'));
    try {
      const relPath = 'templates/child.json';
      const abs = path.join(tmpDir, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(
        abs,
        JSON.stringify({
          stages: [
            {
              name: 's',
              prompt: 'x',
              mounts: {},
              transitions: [{ marker: 'DONE', next: null }],
            },
          ],
        }),
      );
      const out = loadFanoutTemplate(tmpDir, relPath, 'fan');
      expect(out.stages).toHaveLength(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects template path that escapes groupDir', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-fanout-'));
    try {
      expect(() => loadFanoutTemplate(tmpDir, '../escape.json', 'fan')).toThrow(
        /escapes groupDir/,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects missing template file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-fanout-'));
    try {
      expect(() => loadFanoutTemplate(tmpDir, 'missing.json', 'fan')).toThrow(
        /template file not found/,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
