import { useState } from 'react';
import { AGENT_TEMPLATES, COMMAND_TEMPLATES, type TemplateEntry } from '../templates';

function TemplatePreview({ entry }: { entry: TemplateEntry }) {
  const { stage } = entry;
  const mountEntries = Object.entries(stage.mounts).filter(([, v]) => v != null);

  return (
    <div className="tpl-preview">
      <div className="tpl-preview-header">
        <span className="tpl-preview-name">{entry.name}</span>
        <span className={`tpl-preview-badge tpl-badge-${entry.type}`}>{entry.type}</span>
      </div>
      <div className="tpl-preview-desc">{entry.description}</div>

      {stage.image && (
        <div className="tpl-preview-row">
          <span className="tpl-preview-key">image</span>
          <span className="tpl-preview-val">{stage.image}</span>
        </div>
      )}

      {mountEntries.length > 0 && (
        <div className="tpl-preview-section">
          <span className="tpl-preview-key">mounts</span>
          <div className="tpl-preview-mounts">
            {mountEntries.map(([k, v]) => (
              <span key={k} className="tpl-mount-tag">
                {k}<span className="tpl-mount-mode">{v}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {stage.transitions.length > 0 && (
        <div className="tpl-preview-section">
          <span className="tpl-preview-key">transitions</span>
          <div className="tpl-preview-transitions">
            {stage.transitions.map((t, i) => (
              <span key={i} className="tpl-transition-tag">
                {t.marker}{t.next ? ` \u2192 ${t.next}` : ''}
              </span>
            ))}
          </div>
        </div>
      )}

      {stage.command && (
        <div className="tpl-preview-section">
          <span className="tpl-preview-key">command</span>
          <pre className="tpl-preview-cmd">{stage.command}</pre>
        </div>
      )}
    </div>
  );
}

function TemplateItem({ entry, selected, onSelect }: {
  entry: TemplateEntry;
  selected: boolean;
  onSelect: (entry: TemplateEntry) => void;
}) {
  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('application/aer-art-template', JSON.stringify(entry));
    e.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div
      className={`tpl-item${selected ? ' selected' : ''}`}
      draggable
      onDragStart={onDragStart}
      onClick={() => onSelect(entry)}
    >
      <span className="tpl-item-name">{entry.name}</span>
      <span className="tpl-item-desc">{entry.description}</span>
    </div>
  );
}

function Category({ label, items, selectedEntry, onSelect, defaultOpen = false }: {
  label: string;
  items: TemplateEntry[];
  selectedEntry: TemplateEntry | null;
  onSelect: (entry: TemplateEntry) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="tpl-category">
      <button className="tpl-category-toggle" onClick={() => setOpen(!open)}>
        <span className="tpl-category-arrow">{open ? '\u25BE' : '\u25B8'}</span>
        <span className="tpl-category-label">{label}</span>
        <span className="tpl-category-count">{items.length}</span>
      </button>
      {open && (
        <div className="tpl-category-items">
          {items.map((entry) => (
            <TemplateItem
              key={entry.name}
              entry={entry}
              selected={selectedEntry?.name === entry.name}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function TemplatesPanel() {
  const [selectedEntry, setSelectedEntry] = useState<TemplateEntry | null>(null);

  const handleSelect = (entry: TemplateEntry) => {
    setSelectedEntry((prev) => (prev?.name === entry.name ? null : entry));
  };

  const gitTemplates = COMMAND_TEMPLATES.filter((t) => t.category === 'git');
  const generalTemplates = COMMAND_TEMPLATES.filter((t) => t.category === 'general');

  return (
    <div className="templates-panel">
      <div className="tpl-header">TEMPLATES</div>
      <div className="tpl-list">
        <Category label="Agent" items={AGENT_TEMPLATES} selectedEntry={selectedEntry} onSelect={handleSelect} defaultOpen />
        <Category label="Git" items={gitTemplates} selectedEntry={selectedEntry} onSelect={handleSelect} defaultOpen />
        {generalTemplates.length > 0 && (
          <Category label="General" items={generalTemplates} selectedEntry={selectedEntry} onSelect={handleSelect} />
        )}
      </div>
      {selectedEntry ? (
        <TemplatePreview entry={selectedEntry} />
      ) : (
        <div className="tpl-hint">Click to preview, drag onto canvas</div>
      )}
    </div>
  );
}
