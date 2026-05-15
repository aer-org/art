/**
 * /api/debug/memory — runtime observability for OOM diagnosis.
 *
 * Reports Node's heap/rss + a handful of in-process counters bumped
 * from hot paths (SSE writes, snapshot sends, etc.). Designed to be
 * curl'd periodically while a run is active so a developer can spot:
 *
 *   - heapUsed climbing while no work is happening      → leak
 *   - sseWritesBackpressured climbing                   → slow client
 *   - sseConnections > 1 across reloads                 → SSE leak
 *   - snapshotSendsTotal growing very fast              → hot loop
 *
 * No auth — this is a developer tool on a local server.
 */
import type { FastifyInstance } from 'fastify';

import { debugStats } from '../debug-stats.ts';
import { projectState } from '../project-state.ts';
import { runController } from '../run-controller.ts';

export function registerDebugRoutes(app: FastifyInstance): void {
  app.get('/api/debug/memory', async () => {
    const m = process.memoryUsage();
    const project = projectState.current;
    return {
      ts: new Date().toISOString(),
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      memory: {
        rss: m.rss,
        heapTotal: m.heapTotal,
        heapUsed: m.heapUsed,
        external: m.external,
        arrayBuffers: m.arrayBuffers,
        rssMB: +(m.rss / 1024 / 1024).toFixed(1),
        heapUsedMB: +(m.heapUsed / 1024 / 1024).toFixed(1),
        heapTotalMB: +(m.heapTotal / 1024 / 1024).toFixed(1),
      },
      sse: {
        currentConnections: debugStats.sseConnections,
        totalOpened: debugStats.sseTotalConnections,
        writesTotal: debugStats.sseWritesTotal,
        writesBackpressured: debugStats.sseWritesBackpressured,
        snapshotSendsTotal: debugStats.snapshotSendsTotal,
        snapshotBytesAvg:
          debugStats.snapshotSendsTotal > 0
            ? Math.round(
                debugStats.snapshotBytesTotal /
                  debugStats.snapshotSendsTotal,
              )
            : 0,
        snapshotBytesTotal: debugStats.snapshotBytesTotal,
      },
      listeners: {
        runController: {
          starting: runController.listenerCount('starting'),
          start: runController.listenerCount('start'),
          stopping: runController.listenerCount('stopping'),
          exit: runController.listenerCount('exit'),
          log: runController.listenerCount('log'),
          'log-reset': runController.listenerCount('log-reset'),
        },
        project: project
          ? {
              snapshot: project.listenerCount('snapshot'),
              'log-line': project.listenerCount('log-line'),
              'node-log-line': project.listenerCount('node-log-line'),
            }
          : null,
      },
    };
  });

  app.post('/api/debug/gc', async () => {
    if (typeof (global as { gc?: () => void }).gc !== 'function') {
      return {
        ok: false,
        reason:
          'global.gc is unavailable. Start node with --expose-gc to enable.',
      };
    }
    const before = process.memoryUsage();
    (global as { gc?: () => void }).gc!();
    const after = process.memoryUsage();
    return {
      ok: true,
      before: { rss: before.rss, heapUsed: before.heapUsed },
      after: { rss: after.rss, heapUsed: after.heapUsed },
      freedRssMB: +((before.rss - after.rss) / 1024 / 1024).toFixed(1),
      freedHeapMB: +((before.heapUsed - after.heapUsed) / 1024 / 1024).toFixed(
        1,
      ),
    };
  });
}
