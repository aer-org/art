import { useEffect, useState } from 'react';

import { api } from '../lib/api.ts';

interface Props {
  // Static-text mode (overview): provide command + optional meta
  // directly. When `text` is set, runId/nodeId/stageName are ignored
  // and no fetch happens.
  text?: string | null;
  meta?: Record<string, unknown> | null;
  // Overview script-fetch mode: when a local stage name is provided,
  // viewer fetches __art__/scripts/<name>.sh via /api/stage/:name/script
  // and renders its body. `meta` (if supplied) is rendered alongside.
  scriptStageName?: string;
  runId?: string;
  nodeId?: string;
  stageName?: string;
}

export function L3CommandViewer({
  text: textProp,
  meta: metaProp,
  scriptStageName,
  runId,
  nodeId,
  stageName,
}: Props) {
  const isStatic = textProp !== undefined;
  const useScriptFetch = !isStatic && scriptStageName !== undefined;
  const [data, setData] = useState<{
    sh: string | null;
    meta: Record<string, unknown> | null;
  } | null>(
    isStatic ? { sh: textProp ?? '', meta: metaProp ?? null } : null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isStatic) {
      setData({ sh: textProp ?? '', meta: metaProp ?? null });
      setError(null);
      return;
    }
    if (useScriptFetch && scriptStageName) {
      let cancelled = false;
      api
        .stageScript(scriptStageName)
        .then((r) => {
          if (cancelled) return;
          if (!r.exists) {
            setError(`Script not found: ${r.hostPath}`);
            return;
          }
          setData({
            sh: r.truncated
              ? (r.content ?? '') + '\n\n# … (truncated)'
              : (r.content ?? ''),
            meta: metaProp ?? null,
          });
        })
        .catch((err: Error) => {
          if (!cancelled) setError(err.message);
        });
      return () => {
        cancelled = true;
      };
    }
    if (!runId || !nodeId || !stageName) return;
    let cancelled = false;
    api
      .stageCommand(runId, nodeId, stageName)
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [
    isStatic,
    textProp,
    metaProp,
    useScriptFetch,
    scriptStageName,
    runId,
    nodeId,
    stageName,
  ]);

  if (error) return <p className="error">{error}</p>;
  if (data === null) return <p className="muted">Loading…</p>;

  const shell = typeof data.meta?.shell === 'string' ? data.meta.shell : 'sh -c';
  const timeoutMs = data.meta?.timeoutMs;
  const env = (data.meta?.env ?? {}) as Record<string, string>;
  const envKeys = Object.keys(env);

  return (
    <div className="l3-text">
      <div className="l3-meta">
        <span className="muted">shell </span>
        <code>{shell}</code>
        {typeof timeoutMs === 'number' && (
          <>
            <span className="muted"> · timeout </span>
            <code>{timeoutMs}ms</code>
          </>
        )}
        {data.sh && (
          <button
            className="link-btn"
            onClick={() => navigator.clipboard?.writeText(data.sh ?? '')}
            title="Copy"
          >
            copy
          </button>
        )}
      </div>
      <pre className="l3-pre">{data.sh ?? '(no command.sh)'}</pre>
      {envKeys.length > 0 && (
        <>
          <h4 className="l3-h4">Environment</h4>
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
    </div>
  );
}
