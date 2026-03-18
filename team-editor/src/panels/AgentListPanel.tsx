import { useState } from 'react';
import type { AgentConfig } from '../types';

interface Props {
  agents: AgentConfig[];
  selectedIdx: number;
  onSelect: (idx: number) => void;
  onAdd: (name: string, folder: string) => void;
  onDelete: (idx: number) => void;
  onUpdate: (idx: number, partial: Partial<AgentConfig>) => void;
}

export function AgentListPanel({ agents, selectedIdx, onSelect, onAdd, onDelete, onUpdate }: Props) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newFolder, setNewFolder] = useState('');
  const [editIdx, setEditIdx] = useState<number | null>(null);

  const handleAdd = () => {
    if (!newName.trim() || !newFolder.trim()) return;
    onAdd(newName.trim(), newFolder.trim());
    setNewName('');
    setNewFolder('');
    setAdding(false);
  };

  return (
    <div className="agent-list-panel">
      <div className="agent-list-header">AGENTS</div>
      <div className="agent-list">
        {agents.map((agent, idx) => (
          <div
            key={idx}
            className={`agent-card ${idx === selectedIdx ? 'selected' : ''}`}
            onClick={() => onSelect(idx)}
          >
            {editIdx === idx ? (
              <div className="agent-card-edit" onClick={(e) => e.stopPropagation()}>
                <input
                  type="text"
                  value={agent.name}
                  onChange={(e) => onUpdate(idx, { name: e.target.value })}
                  placeholder="Name"
                />
                <input
                  type="text"
                  value={agent.folder}
                  onChange={(e) => onUpdate(idx, { folder: e.target.value })}
                  placeholder="Folder"
                />
                <button className="btn-sm" onClick={() => setEditIdx(null)}>Done</button>
              </div>
            ) : (
              <>
                <div className="agent-card-info">
                  <span className="agent-name">{agent.name}</span>
                  <span className="agent-folder">{agent.folder}/</span>
                </div>
                <div className="agent-card-actions">
                  <button
                    className="btn-icon"
                    title="Edit"
                    onClick={(e) => { e.stopPropagation(); setEditIdx(idx); }}
                  >
                    &#9998;
                  </button>
                  <button
                    className="btn-icon btn-icon-danger"
                    title="Delete"
                    onClick={(e) => { e.stopPropagation(); onDelete(idx); }}
                  >
                    &times;
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      {adding ? (
        <div className="agent-add-form">
          <input
            type="text"
            placeholder="Agent name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            autoFocus
          />
          <input
            type="text"
            placeholder="Folder name"
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
          />
          <div className="agent-add-buttons">
            <button className="btn-sm" onClick={handleAdd}>Add</button>
            <button className="btn-sm" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="btn-add-agent" onClick={() => setAdding(true)}>+ Agent</button>
      )}
    </div>
  );
}
