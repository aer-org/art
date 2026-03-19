import type { Node } from '@xyflow/react';
import type { PipelineStage, PipelineTransition } from '../types';
import { getMountOptions } from '../types';

interface Props {
  node: Node | null;
  onUpdate: (id: string, stage: PipelineStage) => void;
  onDelete: (id: string) => void;
  onSetEntry: (id: string) => void;
  artDirs?: string[];
  imageKeys?: string[];
  onEditPrompt?: (stageId: string, prompt: string, onChange: (prompt: string) => void) => void;
}

export function PropertiesPanel({ node, onUpdate, onDelete, onSetEntry, artDirs, imageKeys, onEditPrompt }: Props) {
  if (!node) {
    return <div className="panel empty-panel">Select a stage to edit</div>;
  }

  const stage = node.data.stage as PipelineStage;
  const isEntry = node.data.isEntry as boolean | undefined;

  const update = (partial: Partial<PipelineStage>) => {
    onUpdate(node.id, { ...stage, ...partial });
  };

  const updateTransition = (idx: number, partial: Partial<PipelineTransition>) => {
    const transitions = stage.transitions.map((t, i) =>
      i === idx ? { ...t, ...partial } : t,
    );
    update({ transitions });
  };

  const addTransition = () => {
    update({
      transitions: [
        ...stage.transitions,
        { marker: 'NEW_MARKER', next: null, prompt: '' },
      ],
    });
  };

  const removeTransition = (idx: number) => {
    update({ transitions: stage.transitions.filter((_, i) => i !== idx) });
  };

  return (
    <div className="panel">
      <h3>Stage Properties</h3>

      <label>
        Name
        <input
          type="text"
          value={stage.name}
          onChange={(e) => update({ name: e.target.value })}
        />
      </label>

      <label>
        Image
        <select
          value={stage.image || 'default'}
          onChange={(e) => update({ image: e.target.value === 'default' ? undefined : e.target.value })}
        >
          {(imageKeys && imageKeys.length > 0 ? imageKeys : ['default']).map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
      </label>

      <label>
        Prompt
        <div style={{ position: 'relative' }}>
          <textarea
            rows={4}
            value={stage.prompt}
            onChange={(e) => update({ prompt: e.target.value })}
            style={{ paddingRight: '60px' }}
          />
          {onEditPrompt && (
            <button
              onClick={() => onEditPrompt(node.id, stage.prompt, (p) => update({ prompt: p }))}
              style={{
                position: 'absolute',
                top: '4px',
                right: '4px',
                fontSize: '11px',
                padding: '2px 8px',
                background: '#313244',
                color: '#cdd6f4',
                border: '1px solid #45475a',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              Expand
            </button>
          )}
        </div>
      </label>

      <fieldset>
        <legend>Mounts</legend>
        {Object.entries(getMountOptions(stage, artDirs))
          .sort(([a], [b]) => {
            const rank = (k: string) => {
              const v = stage.mounts[k];
              if (v === 'rw') return 0;
              if (v === 'ro') return 1;
              return 2; // null / disabled
            };
            return rank(a) - rank(b);
          })
          .map(([key, opts]) => (
          <label key={key} className="mount-row">
            <span className="mount-key">{key}</span>
            <select
              value={stage.mounts[key] ?? 'null'}
              onChange={(e) => {
                const val = e.target.value === 'null' ? null : e.target.value as 'ro' | 'rw';
                update({ mounts: { ...stage.mounts, [key]: val } });
              }}
            >
              {opts.map((o) => (
                <option key={o} value={o}>
                  {o === 'null' ? 'disabled' : o}
                </option>
              ))}
            </select>
          </label>
        ))}
      </fieldset>

      <fieldset>
        <legend>Transitions</legend>
        {(stage.transitions || []).map((t, idx) => (
          <div key={idx} className="transition-row">
            <label>
              Marker
              <input
                type="text"
                value={t.marker}
                onChange={(e) => updateTransition(idx, { marker: e.target.value })}
              />
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={t.retry ?? false}
                onChange={(e) =>
                  updateTransition(idx, { retry: e.target.checked || undefined })
                }
              />
              Retry (error)
            </label>
            <label>
              Prompt
              <input
                type="text"
                value={t.prompt || ''}
                placeholder="When to use this marker"
                onChange={(e) => updateTransition(idx, { prompt: e.target.value || undefined })}
              />
            </label>
            <button
              className="btn-sm btn-danger"
              onClick={() => removeTransition(idx)}
            >
              ×
            </button>
          </div>
        ))}
        <button className="btn-sm" onClick={addTransition}>
          + Transition
        </button>
      </fieldset>

      <label>
        Devices (comma-separated)
        <input
          type="text"
          value={(stage.devices || []).join(', ')}
          onChange={(e) => {
            const devices = e.target.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            update({ devices: devices.length > 0 ? devices : undefined });
          }}
        />
      </label>

      <label>
        Exclusive lock
        <input
          type="text"
          value={stage.exclusive || ''}
          placeholder="e.g. fpga_board"
          onChange={(e) => update({ exclusive: e.target.value || undefined })}
        />
      </label>

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={stage.runAsRoot ?? false}
          onChange={(e) => update({ runAsRoot: e.target.checked || undefined })}
        />
        Run as root
      </label>

      {!isEntry && (
        <button className="btn-entry" onClick={() => onSetEntry(node.id)}>
          Set as Entry
        </button>
      )}
      {isEntry && (
        <span className="entry-indicator">This is the entry stage</span>
      )}

      <button className="btn-danger" onClick={() => onDelete(node.id)}>
        Delete Stage
      </button>
    </div>
  );
}
