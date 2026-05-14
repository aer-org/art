import { useEffect, useState } from 'react';

import { api } from '../lib/api.ts';

interface Props {
  runId: string;
}

export function L4RunInfo({ runId }: Props) {
  const [prov, setProv] = useState<Record<string, unknown> | null>(null);
  const [snap, setSnap] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.runProvenance(runId).catch(() => null),
      api.runPipelineSnap(runId).catch(() => null),
    ]).then(([p, s]) => {
      if (!cancelled) {
        setProv(p);
        setSnap(s);
        if (!p && !s) setError('No provenance or pipeline snapshot recorded.');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (error) return <p className="error">{error}</p>;
  if (!prov && !snap) return <p className="muted">Loading…</p>;

  const agents = (prov?.agents as Array<{
    path: string;
    sha256: string;
    bytes: number;
  }>) ?? [];
  const templates = (prov?.templates as Array<{
    path: string;
    sha256: string;
    bytes: number;
  }>) ?? [];
  const env = (prov?.env ?? {}) as Record<string, string>;
  const envKeys = Object.keys(env).sort();

  return (
    <div className="l3-text">
      {prov && (
        <>
          <h4 className="l3-h4">Provenance</h4>

          {agents.length === 0 ? (
            <p className="muted">No agent files.</p>
          ) : (
            <>
              <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                agents · {agents.length}
              </div>
              <table className="l3-table">
                <tbody>
                  {agents.map((a) => (
                    <tr key={a.path}>
                      <td>
                        <code>{a.path}</code>
                      </td>
                      <td className="num muted">{a.bytes}B</td>
                      <td>
                        <code className="muted">{a.sha256.slice(0, 12)}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {templates.length > 0 && (
            <>
              <div
                className="muted"
                style={{ fontSize: 11, marginTop: 12, marginBottom: 4 }}
              >
                templates · {templates.length}
              </div>
              <table className="l3-table">
                <tbody>
                  {templates.map((t) => (
                    <tr key={t.path}>
                      <td>
                        <code>{t.path}</code>
                      </td>
                      <td className="num muted">{t.bytes}B</td>
                      <td>
                        <code className="muted">{t.sha256.slice(0, 12)}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {envKeys.length > 0 && (
            <>
              <h4 className="l3-h4">Env snapshot ({envKeys.length})</h4>
              <table className="l3-table">
                <tbody>
                  {envKeys.map((k) => (
                    <tr key={k}>
                      <td>
                        <code>{k}</code>
                      </td>
                      <td>
                        <code className="muted">{env[k]}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
      {snap && (
        <>
          <h4 className="l3-h4">pipeline.snap.json</h4>
          <pre className="l3-pre">{JSON.stringify(snap, null, 2)}</pre>
        </>
      )}
    </div>
  );
}
