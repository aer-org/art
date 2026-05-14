/**
 * RunDetailPage — Phase C placeholder. Currently just shows the raw header
 * + node tree so we can wire the route plumbing now and fill it in later.
 */
import { useEffect, useState } from 'react';

import { api, type RunDetail } from '../lib/api.ts';
import { hrefFor } from '../router.tsx';

export function RunDetailPage(props: { runId: string }): JSX.Element {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .runDetail(props.runId)
      .then((d) => {
        if (!cancelled) {
          setDetail(d);
          setError(null);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [props.runId]);

  return (
    <div className="run-detail-page">
      <p>
        <a href={hrefFor('/runs')}>← Back to runs</a>
      </p>
      {error && <p className="error">Failed to load: {error}</p>}
      {detail && (
        <>
          <h2>
            <code>{detail.runId}</code>
          </h2>
          <ul className="run-detail-header">
            <li>State: <strong>{detail.state}</strong></li>
            <li>Provider: {detail.provider ?? '-'}</li>
            <li>Started: <code>{detail.startTime ?? '-'}</code></li>
            <li>Ended: <code>{detail.endTime ?? '-'}</code></li>
            <li>Outcome: {detail.outcome ?? '-'}</li>
            <li>Has provenance: {String(detail.hasProvenance)}</li>
            <li>Has pipeline snap: {String(detail.hasPipelineSnap)}</li>
            <li>Has events: {String(detail.hasEvents)}</li>
          </ul>
          <h3>Nodes</h3>
          <pre>{JSON.stringify(detail.nodes, null, 2)}</pre>
          <p className="muted">
            Full visualizer rendering arrives in Phase C (StageSidebar, L3
            panels). For now this confirms the route + API plumbing works.
          </p>
        </>
      )}
      {!detail && !error && <p className="muted">Loading…</p>}
    </div>
  );
}
