/**
 * Bounded tail buffer for container stdout/stderr capture.
 *
 * Replaces the unbounded `let stdout = ''` / `stdout += chunk` pattern in
 * container-runner.ts and pipeline-runner.ts (runStageCommand). Keeps the
 * *last* `maxBytes` of text — the assumption baked into the rest of the
 * runtime is that the interesting content (marker payload, error tail,
 * recent log lines) lives near the end, while the full transcript is
 * already archived to disk via stage write streams.
 *
 * Implementation: array of chunks + running byte total. On append, evict
 * whole chunks from the head while the total exceeds the limit. If a
 * single chunk on its own exceeds the limit, slice it.
 *
 * `toString()` returns the current tail — callers that previously did
 * substring searches on the full accumulator (e.g. `parseStageMarkers`)
 * keep working, just over a window instead of the full history.
 */
export class TailBuffer {
  private chunks: string[] = [];
  private total = 0;
  private droppedBytes = 0;

  constructor(private readonly maxBytes: number) {
    if (maxBytes <= 0) throw new Error('TailBuffer maxBytes must be > 0');
  }

  append(chunk: string): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.total += chunk.length;

    while (this.total > this.maxBytes && this.chunks.length > 1) {
      const head = this.chunks.shift()!;
      this.total -= head.length;
      this.droppedBytes += head.length;
    }

    if (this.chunks.length === 1 && this.total > this.maxBytes) {
      const overflow = this.total - this.maxBytes;
      const head = this.chunks[0];
      this.chunks[0] = head.slice(overflow);
      this.total = this.maxBytes;
      this.droppedBytes += overflow;
    }
  }

  toString(): string {
    if (this.chunks.length === 0) return '';
    if (this.chunks.length === 1) return this.chunks[0];
    return this.chunks.join('');
  }

  get length(): number {
    return this.total;
  }

  get truncated(): boolean {
    return this.droppedBytes > 0;
  }

  get droppedFromHead(): number {
    return this.droppedBytes;
  }
}
