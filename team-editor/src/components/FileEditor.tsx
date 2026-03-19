import { useState, useEffect, useCallback, useRef } from 'react';

interface Props {
  /** Relative path within __art__/, e.g. "plan/PLAN.md" */
  filePath: string;
  onClose: () => void;
  onSaved?: () => void;
}

export function FileEditor({ filePath, onClose, onSaved }: Props) {
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setLoading(true);
    setStatus('');
    fetch(`/api/file?path=${encodeURIComponent(filePath)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        setContent(text);
        setOriginal(text);
      })
      .catch(() => {
        setContent('');
        setOriginal('');
      })
      .finally(() => {
        setLoading(false);
        setTimeout(() => textareaRef.current?.focus(), 50);
      });
  }, [filePath]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setStatus('');
    try {
      const resp = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: content,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setOriginal(content);
      setStatus('Saved');
      onSaved?.();
      setTimeout(() => setStatus(''), 2000);
    } catch {
      setStatus('Save failed');
    } finally {
      setSaving(false);
    }
  }, [filePath, content, onSaved]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Ctrl/Cmd+S to save
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
      // Escape to close
      if (e.key === 'Escape') {
        onClose();
      }
      // Tab to indent
      if (e.key === 'Tab') {
        e.preventDefault();
        const ta = textareaRef.current;
        if (!ta) return;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const newContent = content.slice(0, start) + '  ' + content.slice(end);
        setContent(newContent);
        setTimeout(() => {
          ta.selectionStart = ta.selectionEnd = start + 2;
        }, 0);
      }
    },
    [handleSave, onClose, content],
  );

  const isDirty = content !== original;
  const fileName = filePath.split('/').pop() || filePath;

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 1000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(17, 17, 27, 0.92)',
    }}>
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        width: '800px',
        maxWidth: '95vw',
        height: '85vh',
        maxHeight: '900px',
        background: '#1e1e2e',
        border: '1px solid #313244',
        borderRadius: '16px',
        boxShadow: '0 12px 48px rgba(0, 0, 0, 0.5)',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '12px 16px',
          borderBottom: '1px solid #313244',
          background: '#181825',
        }}>
          <span style={{ fontSize: '13px', color: '#6c7086' }}>{filePath.split('/').slice(0, -1).join('/') + '/'}</span>
          <span style={{ fontSize: '14px', fontWeight: 600, color: '#cdd6f4' }}>
            {fileName}{isDirty && ' *'}
          </span>
          <div style={{ flex: 1 }} />
          {status && (
            <span style={{ fontSize: '12px', color: status === 'Saved' ? '#a6e3a1' : '#f38ba8' }}>
              {status}
            </span>
          )}
          <span style={{ fontSize: '11px', color: '#45475a' }}>Ctrl+S save / Esc close</span>
          <button
            onClick={handleSave}
            disabled={!isDirty || saving}
            style={{
              fontSize: '12px',
              padding: '4px 14px',
              background: isDirty ? '#22c55e' : '#313244',
              color: isDirty ? '#fff' : '#6c7086',
              border: 'none',
              borderRadius: '6px',
              cursor: isDirty ? 'pointer' : 'default',
              fontWeight: 600,
            }}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={onClose}
            style={{
              fontSize: '18px',
              background: 'transparent',
              border: 'none',
              color: '#6c7086',
              cursor: 'pointer',
              padding: '0 4px',
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {/* Editor */}
        {loading ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6c7086' }}>
            Loading...
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
            style={{
              flex: 1,
              background: '#11111b',
              color: '#cdd6f4',
              border: 'none',
              padding: '16px 20px',
              fontSize: '13px',
              fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
              lineHeight: '1.6',
              resize: 'none',
              outline: 'none',
              tabSize: 2,
            }}
          />
        )}
      </div>
    </div>
  );
}
