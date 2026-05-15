/**
 * Tiny in-memory counter store for runtime observability. Bumped from
 * hot paths in routes/state.ts (sendSnapshot, SSE writes) so we can
 * `curl /api/debug/memory` and see actual allocation rate, SSE
 * pressure, and listener growth — instead of guessing why the server
 * is bloating.
 */

interface Counters {
  sseConnections: number;
  sseTotalConnections: number;
  sseWritesTotal: number;
  sseWritesBackpressured: number;
  snapshotSendsTotal: number;
  snapshotBytesTotal: number;
}

export const debugStats: Counters = {
  sseConnections: 0,
  sseTotalConnections: 0,
  sseWritesTotal: 0,
  sseWritesBackpressured: 0,
  snapshotSendsTotal: 0,
  snapshotBytesTotal: 0,
};
