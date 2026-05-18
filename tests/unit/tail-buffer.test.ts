import { describe, it, expect } from 'vitest';

import { TailBuffer } from '../../src/tail-buffer.js';

describe('TailBuffer', () => {
  it('returns all content when under cap', () => {
    const b = new TailBuffer(100);
    b.append('hello ');
    b.append('world');
    expect(b.toString()).toBe('hello world');
    expect(b.length).toBe(11);
    expect(b.truncated).toBe(false);
  });

  it('evicts whole chunks from head when total exceeds cap', () => {
    const b = new TailBuffer(10);
    b.append('aaaaa'); // 5 bytes
    b.append('bbbbb'); // 10 bytes total — at cap
    b.append('cc'); // overflow → 'aaaaa' (5) evicted, total = 7
    expect(b.toString()).toBe('bbbbbcc');
    expect(b.length).toBe(7);
    expect(b.truncated).toBe(true);
    expect(b.droppedFromHead).toBe(5);
  });

  it('slices the only chunk when it alone exceeds the cap', () => {
    const b = new TailBuffer(5);
    b.append('0123456789'); // 10 bytes into a 5-byte buffer
    expect(b.toString()).toBe('56789');
    expect(b.length).toBe(5);
    expect(b.truncated).toBe(true);
    expect(b.droppedFromHead).toBe(5);
  });

  it('keeps invariant under many small appends', () => {
    const b = new TailBuffer(50);
    let expected = '';
    for (let i = 0; i < 1000; i++) {
      const s = `[${i}]`;
      b.append(s);
      expected += s;
    }
    // Tail must equal the last 50 chars of the concatenation.
    expect(b.toString()).toBe(expected.slice(-50));
    expect(b.length).toBe(50);
    expect(b.truncated).toBe(true);
  });

  it('handles empty appends without growing', () => {
    const b = new TailBuffer(10);
    b.append('');
    b.append('xx');
    b.append('');
    expect(b.toString()).toBe('xx');
    expect(b.length).toBe(2);
  });

  it('preserves marker payloads at the tail', () => {
    // Simulates a long script that emits noise followed by a fenced
    // marker block at the end — exactly the pattern container/runStageCommand
    // marker scanning relies on.
    const b = new TailBuffer(200);
    for (let i = 0; i < 1000; i++) {
      b.append(`noise line ${i}\n`);
    }
    b.append(
      '[STAGE_COMPLETE]\n---PAYLOAD_START---\n{"ok":true}\n---PAYLOAD_END---\n',
    );
    const tail = b.toString();
    expect(tail).toContain('[STAGE_COMPLETE]');
    expect(tail).toContain('---PAYLOAD_START---');
    expect(tail).toContain('"ok":true');
    expect(tail).toContain('---PAYLOAD_END---');
  });

  it('rejects non-positive maxBytes', () => {
    expect(() => new TailBuffer(0)).toThrow();
    expect(() => new TailBuffer(-1)).toThrow();
  });
});
