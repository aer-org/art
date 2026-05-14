/**
 * App shell — hash router + top nav. Body delegates to the right page.
 * Preflight + currentSnapshot are kept at this level so the projectDir
 * known to Live also drives /api/runs queries on the Runs/RunDetail
 * pages (they share the server's projectState singleton).
 */
import { useEffect, useState } from 'react';

import { LivePage } from './pages/LivePage.tsx';
import { RunDetailPage } from './pages/RunDetailPage.tsx';
import { RunsListPage } from './pages/RunsListPage.tsx';
import {
  api,
  type PipelineSnapshot,
  type PreflightResponse,
} from './lib/api.ts';
import { hrefFor, useRoute } from './router.tsx';

export function App(): JSX.Element {
  const route = useRoute();
  const [preflight, setPreflight] = useState<PreflightResponse | null>(null);
  const [projectDir, setProjectDir] = useState<string | null>(null);

  useEffect(() => {
    api.preflight().then(setPreflight).catch(() => {});
  }, []);

  // Keep projectDir in sync with the server's loaded project; useful for
  // the Runs tab which needs to know whether a project is mounted.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api
        .current()
        .then((s: PipelineSnapshot) => {
          if (!cancelled) setProjectDir(s.projectDir);
        })
        .catch(() => {});
    };
    load();
    // Re-poll when the hash changes (cheap; lets the Runs tab notice
    // a project was loaded over on the Live tab without a hard refresh).
    const t = window.setInterval(load, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

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
        <LivePage preflight={preflight} setPreflight={setPreflight} />
      )}
      {route.kind === 'runs-list' && <RunsListPage projectDir={projectDir} />}
      {route.kind === 'run-detail' && (
        <RunDetailPage runId={route.runId} initialParams={route.params} />
      )}
    </>
  );
}
