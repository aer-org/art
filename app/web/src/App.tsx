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
