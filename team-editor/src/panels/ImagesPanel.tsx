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

const PRESET_IMAGES = [
  { label: 'Ubuntu 24.04', value: 'ubuntu:24.04' },
  { label: 'Ubuntu 22.04', value: 'ubuntu:22.04' },
  { label: 'Debian Bookworm', value: 'debian:bookworm' },
  { label: 'NVIDIA CUDA 12.8 (Ubuntu 24.04)', value: 'nvidia/cuda:12.8.0-base-ubuntu24.04' },
  { label: 'NVIDIA CUDA 12.8 (Ubuntu 22.04)', value: 'nvidia/cuda:12.8.0-base-ubuntu22.04' },
  { label: 'Python 3.12', value: 'python:3.12' },
  { label: 'Node.js 22', value: 'node:22' },
  { label: 'ROS 2 Jazzy', value: 'ros:jazzy' },
  { label: 'Custom', value: '__custom__' },
] as const;

export function ImagesPanel({ registry, onRefresh }: Props) {
  const [key, setKey] = useState('');
  const [selectedPreset, setSelectedPreset] = useState('');
  const [customImage, setCustomImage] = useState('');
  const [hasAgent, setHasAgent] = useState(true);

  const baseImage = selectedPreset === '__custom__' ? customImage : selectedPreset;
  const [error, setError] = useState('');

  const handleAdd = async () => {
    if (!key || !baseImage) return;
    setError('');

    try {
      const resp = await fetch('/api/images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, baseImage, hasAgent }),
      });
      if (!resp.ok) {
        const data = await resp.json();
        setError(data.error || 'Failed to add image');
        return;
      }
      setKey('');
      setSelectedPreset('');
      setCustomImage('');
      onRefresh();
    } catch (err) {
      setError((err as Error).message);
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
          />
        </label>
        <label>
          Base Image
          <select
            value={selectedPreset}
            onChange={(e) => setSelectedPreset(e.target.value)}
          >
            <option value="" disabled>Select a base image…</option>
            {PRESET_IMAGES.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </label>
        {selectedPreset === '__custom__' && (
          <label>
            Custom Image
            <input
              type="text"
              value={customImage}
              placeholder="e.g. myregistry/myimage:tag"
              onChange={(e) => setCustomImage(e.target.value)}
            />
          </label>
        )}
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={hasAgent}
            onChange={(e) => setHasAgent(e.target.checked)}
          />
          Install agent stack (Node.js, Claude Code, etc.)
        </label>
        <button onClick={handleAdd} disabled={!key || !baseImage}>
          Add Image
        </button>
      </div>

      {error && <div style={{ color: '#f38ba8', marginTop: 4, fontSize: '0.9em' }}>{error}</div>}
    </div>
  );
}
