/**
 * App shell — hash router + top nav. Body delegates to the right page.
 *
 * Pipeline state + log state are hoisted to this level (`usePipelineState`)
 * so the SSE subscription survives Live ↔ Runs navigation. Otherwise
 * LivePage's local state would reset every time the user clicks Runs,
 * silently dropping all run-log lines that arrived while they were away.
 */
import { useEffect, useState } from 'react';

import { usePipelineState } from './hooks/usePipelineState.ts';
import { LivePage } from './pages/LivePage.tsx';
import { RunDetailPage } from './pages/RunDetailPage.tsx';
import { RunsListPage } from './pages/RunsListPage.tsx';
import { api, type PreflightResponse } from './lib/api.ts';
import { hrefFor, useRoute } from './router.tsx';

export function App(): JSX.Element {
  const route = useRoute();
  const [preflight, setPreflight] = useState<PreflightResponse | null>(null);
  const pipeline = usePipelineState();

  useEffect(() => {
    api.preflight().then(setPreflight).catch(() => {});
  }, []);

  const projectDir = pipeline.snapshot.projectDir;
  // Show the Stop control only when the user is viewing the run that's
  // currently running. `latestRun.runId` is the most-recent on-disk
  // manifest; combined with `isRunning` it identifies the live run.
  const showStop =
    route.kind === 'run-detail' &&
    pipeline.snapshot.isRunning === true &&
    pipeline.snapshot.latestRun?.runId === route.runId;

  return (
    <>
      <nav className="top-nav">
        <a
          href={hrefFor('/')}
          className={route.kind === 'live' ? 'active' : ''}
        >
          Live
        </a>
        <a
          href={hrefFor('/runs')}
          className={
            route.kind === 'runs-list' || route.kind === 'run-detail'
              ? 'active'
              : ''
          }
        >
          Runs
        </a>
        {showStop && <NavStopButton isStopping={!!pipeline.snapshot.isStopping} />}
        {projectDir && (
          <span className="top-nav-project">
            <code>{projectDir}</code>
          </span>
        )}
      </nav>
      {route.kind === 'live' && (
        <LivePage
          preflight={preflight}
          setPreflight={setPreflight}
          pipeline={pipeline}
        />
      )}
      {route.kind === 'runs-list' && <RunsListPage projectDir={projectDir} />}
      {route.kind === 'run-detail' && (
        <RunDetailPage runId={route.runId} initialParams={route.params} />
      )}
    </>
  );
}

function NavStopButton({ isStopping }: { isStopping: boolean }) {
  // Server flips snapshot.isStopping the moment runController.stop()
  // marks the project — happens BEFORE the runner actually exits — so
  // the button reads "stopping…" immediately on click instead of for
  // 1–5 s while the runner shuts down docker / writes summary / etc.
  const [localBusy, setLocalBusy] = useState(false);
  async function onClick() {
    if (isStopping || localBusy) return;
    if (!window.confirm('Send SIGTERM to the running pipeline?')) return;
    setLocalBusy(true);
    try {
      await api.stop();
    } catch (e) {
      window.alert(`Stop failed: ${(e as Error).message}`);
    } finally {
      setLocalBusy(false);
    }
  }
  const busy = isStopping || localBusy;
  return (
    <button
      className="nav-stop"
      onClick={onClick}
      disabled={busy}
      title="SIGTERM the active pipeline runner"
    >
      {busy ? 'stopping…' : '■ stop'}
    </button>
  );
}
