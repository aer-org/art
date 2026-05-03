import { useEffect, useState } from 'react';
import { api, type StageInfoResponse } from '../lib/api.ts';

interface Props {
  name: string;
  onClose: () => void;
}

type Tab = 'config' | 'runtime' | 'logs' | 'transitions';

export function NodeModal({ name, onClose }: Props) {
  const [info, setInfo] = useState<StageInfoResponse | null>(null);
  const [tab, setTab] = useState<Tab>('config');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setInfo(null);
    setError(null);
    api.stage(name).then(setInfo).catch((e) => setError((e as Error).message));
  }, [name]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <strong>{name}</strong>
          <button onClick={onClose}>Close</button>
        </div>
        <div className="modal-tabs">
          {(['config', 'runtime', 'logs', 'transitions'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </div>
        <div className="modal-body">
          {error && <div style={{ color: 'var(--bad)' }}>{error}</div>}
          {!info && !error && <div style={{ color: 'var(--fg-dim)' }}>Loading…</div>}
          {info && tab === 'config' && (
            <pre>{JSON.stringify(info.config ?? { note: 'Not present in PIPELINE.json or insertedStages' }, null, 2)}</pre>
          )}
          {info && tab === 'runtime' && (
            <pre>{JSON.stringify(info.runtime, null, 2)}</pre>
          )}
          {info && tab === 'logs' && (
            <>
              <div style={{ color: 'var(--fg-dim)', marginBottom: 8, fontSize: 12 }}>
                {info.logs.nodeLogFile ? `Node stream from ${info.logs.nodeLogFile}` : 'No pipeline log yet.'}
              </div>
              <div className="log-tail">
                {(info.logs.nodeTail?.map((line) => line.line) ?? info.logs.pipelineTail).join('\n') || '(no entries for this stage)'}
              </div>
              {info.logs.containerLogs.map((c) => (
                <div key={c.file} style={{ marginTop: 12 }}>
                  <div style={{ color: 'var(--fg-dim)', fontSize: 12, marginBottom: 4 }}>{c.file}</div>
                  <div className="log-tail">{c.tail}</div>
                </div>
              ))}
            </>
          )}
          {info && tab === 'transitions' && (
            <pre>{JSON.stringify(info.transitions, null, 2)}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
