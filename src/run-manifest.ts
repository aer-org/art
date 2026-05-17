/**
 * Run identity + the legacy in-memory manifest shape kept on PipelineRunner.
 *
 * After the transparency-foundation migration, manifests are no longer
 * written to disk by `art run` — per-run persistence lives under
 * `runs/<id>/run.json` and `summary.json` via RunRecorder. The in-memory
 * RunManifest type is retained because PipelineRunner still aggregates
 * per-stage outcomes during a run and exposes them at finalize time. The
 * server controller and pipeline-watcher synthesize the same shape from
 * `run.json` + `sealed` marker.
 */
import crypto from 'crypto';

export function generateRunId(): string {
  return `run-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

export interface RunManifest {
  runId: string;
  pid: number;
  startTime: string;
  endTime?: string;
  status: 'running' | 'success' | 'error' | 'cancelled';
  stages: Array<{ name: string; status: string; duration?: number }>;
  logFile?: string;
  outputLogFile?: string;
}
