import { useEffect, useState } from 'react';

import { api } from '../lib/api.ts';

interface Props {
  runId: string;
  nodeId: string;
  stageName: string;
  sizes: { agent: number; stdout: number; stderr: number } | null;
}

type Kind = 'agent' | 'stdout' | 'stderr';

export function L3StreamTail({ runId, nodeId, stageName, sizes }: Props) {
  const available: Kind[] = [];
  if (sizes) {
    if (sizes.agent > 0) available.push('agent');
    if (sizes.stdout > 0) available.push('stdout');
    if (sizes.stderr > 0) available.push('stderr');
  }
  const [kind, setKind] = useState<Kind>(available[0] ?? 'agent');
  const [tail, setTail] = useState(500);
  const [data, setData] = useState<{ lines: string[]; bytes: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    api
      .stageStream(runId, nodeId, stageName, { kind, tail })
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, nodeId, stageName, kind, tail]);

  if (available.length === 0) {
    return (
      <p className="muted">
        No streams recorded (Phase 2 stream-sink migration deferred).
      </p>
    );
  }

  return (
    <div className="l3-text">
      <div className="l3-meta">
        <div className="mount-tabs">
          {available.map((k) => (
            <button
              key={k}
              className={`mount-tab ${k === kind ? 'active' : ''}`}
              onClick={() => setKind(k)}
            >
              {k}
              {sizes && (
                <span className="muted"> · {fmtBytes(sizes[k])}</span>
              )}
            </button>
          ))}
        </div>
        <span className="muted">tail</span>
        <select
          value={tail}
          onChange={(e) => setTail(Number(e.target.value))}
          className="tail-select"
        >
          <option value={100}>100</option>
          <option value={500}>500</option>
          <option value={2000}>2000</option>
        </select>
      </div>
      {error && <p className="error">{error}</p>}
      {data === null && !error && <p className="muted">Loading…</p>}
      {data !== null && (
        <pre className="l3-pre l3-stream">{data.lines.join('\n')}</pre>
      )}
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
