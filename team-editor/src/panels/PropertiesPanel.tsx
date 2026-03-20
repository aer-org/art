import { useState } from 'react';
import type { Node } from '@xyflow/react';
import type { PipelineStage, PipelineTransition } from '../types';
import { getMountOptions } from '../types';
import { MountOverlay } from '../components/MountOverlay';

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
  const [overlayMode, setOverlayMode] = useState<'project' | 'art' | null>(null);

  if (!node) {
    return <div className="panel empty-panel">Select a stage to edit</div>;
  }

  const stage = node.data.stage as PipelineStage;
  const isEntry = node.data.isEntry as boolean | undefined;

  const update = (partial: Partial<PipelineStage>) => {
    onUpdate(node.id, { ...stage, ...partial });
  };

  const hasProjectSubKeys = Object.keys(stage.mounts).some((k) => k.startsWith('project:'));



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
        <div
          onClick={() => onEditPrompt?.(node.id, stage.prompt, (p) => update({ prompt: p }))}
          style={{
            background: '#11111b',
            border: '1px solid #45475a',
            borderRadius: '4px',
            padding: '8px 10px',
            fontSize: '12px',
            color: stage.prompt ? '#cdd6f4' : '#6c7086',
            cursor: 'pointer',
            whiteSpace: 'pre-wrap',
            maxHeight: '80px',
            overflow: 'hidden',
            fontFamily: "'JetBrains Mono', monospace",
            lineHeight: '1.4',
          }}
        >
          {stage.prompt
            ? (stage.prompt.length > 120 ? stage.prompt.slice(0, 120) + '...' : stage.prompt)
            : 'Click to edit prompt...'}
        </div>
      </label>

      <fieldset>
        <legend>Mounts</legend>

        {/* Project Folder group */}
        <div className="mount-group">
          <div className="mount-group-header">
            <span className="mount-group-label">Project Folder</span>
            {hasProjectSubKeys && <span className="mount-group-badge" title="Custom sub-permissions set">*</span>}
          </div>
          <div className="mount-group-row">
            <label className="mount-row">
              <span className="mount-key">project</span>
              <select
                value={stage.mounts['project'] === null ? 'null' : (stage.mounts['project'] || 'ro')}
                onChange={(e) => {
                  const val = e.target.value === 'null' ? null : e.target.value as 'ro' | 'rw';
                  const next = { ...stage.mounts, project: val };
                  // Clear project:* sub-keys when root is disabled
                  if (val === null) {
                    for (const k of Object.keys(next)) {
                      if (k.startsWith('project:')) delete next[k];
                    }
                  }
                  update({ mounts: next });
                }}
              >
                <option value="ro">ro</option>
                <option value="rw">rw</option>
                <option value="null">disabled</option>
              </select>
            </label>
            {stage.mounts['project'] !== null && (
              <button
                className="btn-sm mount-edit-btn"
                onClick={() => setOverlayMode('project')}
              >
                ✎
              </button>
            )}
          </div>
        </div>

        {/* Agent Managed Folder group */}
        <div className="mount-group">
          <div className="mount-group-header">
            <span className="mount-group-label">Agent Managed Folder</span>
          </div>
          <button
            className="btn-sm mount-edit-btn mount-edit-btn-full"
            onClick={() => setOverlayMode('art')}
          >
            ✎ Configure
          </button>
        </div>
      </fieldset>

      {overlayMode === 'project' && (
        <MountOverlay
          mode="project"
          title="Project Folder 권한 설정"
          mounts={stage.mounts}
          onApply={(mounts) => update({ mounts })}
          onClose={() => setOverlayMode(null)}
        />
      )}
      {overlayMode === 'art' && (
        <ArtMountsOverlay
          stage={stage}
          artDirs={artDirs}
          onApply={(mounts) => update({ mounts })}
          onClose={() => setOverlayMode(null)}
        />
      )}


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

type MountPolicy = 'ro' | 'rw' | null | undefined;

function ArtMountsOverlay({ stage, artDirs, onApply, onClose }: {
  stage: PipelineStage;
  artDirs?: string[];
  onApply: (mounts: Record<string, MountPolicy>) => void;
  onClose: () => void;
}) {
  const [mounts, setMounts] = useState<Record<string, MountPolicy>>({ ...stage.mounts });

  const artMountOptions = Object.entries(getMountOptions(stage, artDirs))
    .filter(([key]) => key !== 'project')
    .sort(([a], [b]) => {
      const rank = (k: string) => {
        const v = mounts[k];
        if (v === 'rw') return 0;
        if (v === 'ro') return 1;
        return 2;
      };
      return rank(a) - rank(b);
    });

  return (
    <div
      className="mount-overlay-backdrop"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { onApply(mounts); onClose(); }
      }}
      tabIndex={-1}
    >
      <div className="mount-overlay-modal">
        <div className="mount-overlay-header">
          <span className="mount-overlay-title">Agent Managed Folder 권한 설정</span>
          <span className="mount-overlay-hint">Esc close / Ctrl+Enter apply</span>
          <button className="mount-overlay-close" onClick={onClose}>✕</button>
        </div>
        <div className="mount-overlay-body">
          {artMountOptions.map(([key, opts]) => (
            <div key={key} className="mount-overlay-row">
              <span className="mount-overlay-name">{key}/</span>
              <select
                className="mount-overlay-select"
                value={mounts[key] ?? 'null'}
                onChange={(e) => {
                  const val = e.target.value === 'null' ? null : e.target.value as 'ro' | 'rw';
                  setMounts({ ...mounts, [key]: val });
                }}
              >
                {opts.map((o) => (
                  <option key={o} value={o}>
                    {o === 'null' ? 'disabled' : o}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
        <div className="mount-overlay-footer">
          <button className="mount-overlay-btn mount-overlay-btn-cancel" onClick={onClose}>취소</button>
          <button className="mount-overlay-btn mount-overlay-btn-apply" onClick={() => { onApply(mounts); onClose(); }}>적용</button>
        </div>
      </div>
    </div>
  );
}
