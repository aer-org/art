import { useState } from 'react';

export interface RegisteredImage {
  image: string;
  hasAgent: boolean;
  baseImage?: string;
}

export type ImageRegistry = Record<string, RegisteredImage>;

interface Props {
  registry: ImageRegistry;
  onRefresh: () => void;
}

export function ImagesPanel({ registry, onRefresh }: Props) {
  const [key, setKey] = useState('');
  const [baseImage, setBaseImage] = useState('');
  const [hasAgent, setHasAgent] = useState(true);
  const [building, setBuilding] = useState(false);
  const [buildLog, setBuildLog] = useState('');
  const [error, setError] = useState('');

  const handleAdd = async () => {
    if (!key || !baseImage) return;
    setError('');
    setBuildLog('');

    if (hasAgent) {
      // SSE stream build
      setBuilding(true);
      try {
        const resp = await fetch('/api/images', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, baseImage, hasAgent: true }),
        });
        const reader = resp.body?.getReader();
        if (!reader) return;

        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          // Parse SSE lines
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const evt = JSON.parse(line.slice(6));
              if (evt.type === 'log') {
                setBuildLog((prev) => prev + evt.content);
              } else if (evt.type === 'done') {
                if (!evt.success) {
                  setError(evt.error || 'Build failed');
                }
              }
            } catch { /* skip non-JSON lines */ }
          }
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBuilding(false);
        setKey('');
        setBaseImage('');
        onRefresh();
      }
    } else {
      // Direct register
      try {
        const resp = await fetch('/api/images', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, baseImage, hasAgent: false }),
        });
        if (!resp.ok) {
          const data = await resp.json();
          setError(data.error || 'Failed to add image');
          return;
        }
        setKey('');
        setBaseImage('');
        onRefresh();
      } catch (err) {
        setError((err as Error).message);
      }
    }
  };

  const handleDelete = async (imageKey: string) => {
    try {
      const resp = await fetch(`/api/images?key=${encodeURIComponent(imageKey)}`, {
        method: 'DELETE',
      });
      if (!resp.ok) {
        const data = await resp.json();
        setError(data.error || 'Failed to delete');
        return;
      }
      onRefresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const entries = Object.entries(registry);

  return (
    <div className="panel files-panel">
      <h3>Images</h3>

      {entries.length > 0 && (
        <div className="file-list">
          {entries.map(([k, v]) => (
            <div key={k} className="file-item" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span className="file-name" style={{ fontWeight: k === 'default' ? 'bold' : 'normal' }}>{k}</span>
                <span style={{ opacity: 0.6, fontSize: '0.85em', marginLeft: 6 }}>
                  {v.hasAgent ? '🤖' : '📦'} {v.baseImage || v.image}
                </span>
              </div>
              {k !== 'default' && (
                <button className="btn-sm btn-danger" onClick={() => handleDelete(k)}>×</button>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 8 }}>
        <label>
          Name
          <input
            type="text"
            value={key}
            placeholder="e.g. vivado"
            onChange={(e) => setKey(e.target.value)}
            disabled={building}
          />
        </label>
        <label>
          Base Image
          <input
            type="text"
            value={baseImage}
            placeholder="e.g. nvidia/cuda:12.0.0-base-ubuntu22.04"
            onChange={(e) => setBaseImage(e.target.value)}
            disabled={building}
          />
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={hasAgent}
            onChange={(e) => setHasAgent(e.target.checked)}
            disabled={building}
          />
          Install agent stack (Node.js, Claude Code, etc.)
        </label>
        <button onClick={handleAdd} disabled={building || !key || !baseImage}>
          {building ? 'Building...' : 'Add Image'}
        </button>
      </div>

      {error && <div style={{ color: '#f38ba8', marginTop: 4, fontSize: '0.9em' }}>{error}</div>}

      {buildLog && (
        <pre style={{
          marginTop: 8,
          maxHeight: 200,
          overflow: 'auto',
          fontSize: '0.75em',
          background: '#11111b',
          padding: 8,
          borderRadius: 4,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}>
          {buildLog}
        </pre>
      )}
    </div>
  );
}
