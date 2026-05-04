import { useEffect, useState } from 'react';
import { api, type BrowseResponse, type PipelineSnapshot } from '../lib/api.ts';

interface Props {
  onLoad: (snapshot: PipelineSnapshot) => void;
}

export function DirectoryPicker({ onLoad }: Props) {
  const [browse, setBrowse] = useState<BrowseResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function navigate(path?: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.browse(path);
      setBrowse(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { navigate(); }, []);

  async function load(path: string) {
    setBusy(true);
    setError(null);
    try {
      const snapshot = await api.load(path);
      onLoad(snapshot);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!browse) return <div className="dir-picker">{error ? <span style={{ color: 'var(--bad)' }}>{error}</span> : 'Loading…'}</div>;

  return (
    <div className="dir-picker">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button disabled={busy || !browse.parent} onClick={() => browse.parent && navigate(browse.parent)}>↑</button>
        <button disabled={busy} onClick={() => navigate(browse.home)}>~</button>
        <span className="crumb" title={browse.path}>{browse.path}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          className="primary"
          disabled={busy}
          onClick={() => load(browse.path)}
          title={browse.hasArt ? 'Use this directory' : 'Initialize __art__ and use this directory'}
        >
          Select Project Directory
        </button>
        <span style={{ color: 'var(--fg-dim)', fontSize: 12 }}>
          {browse.hasArt ? 'ART project found.' : 'Will initialize __art__ before loading.'}
        </span>
      </div>
      {error && <div style={{ color: 'var(--bad)', fontSize: 12 }}>{error}</div>}
      <div className="entries">
        {browse.entries.length === 0 && <div className="entry" style={{ color: 'var(--fg-dim)' }}>(no subdirectories)</div>}
        {browse.entries.map((e) => (
          <div
            key={e.path}
            className="entry"
            onClick={() => navigate(e.path)}
          >
            <span>📁 {e.name}</span>
            {e.hasArt && <span className="badge">art</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
