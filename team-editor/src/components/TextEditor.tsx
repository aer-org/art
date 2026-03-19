import { useState, useCallback, useRef, useEffect } from 'react';

interface Props {
  title: string;
  initialValue: string;
  onSave: (value: string) => void;
  onClose: () => void;
}

export function TextEditor({ title, initialValue, onSave, onClose }: Props) {
  const [content, setContent] = useState(initialValue);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, []);

  const isDirty = content !== initialValue;

  const handleSave = useCallback(() => {
    onSave(content);
    onClose();
  }, [content, onSave, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
      if (e.key === 'Escape') {
        onClose();
      }
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
          <span style={{ fontSize: '14px', fontWeight: 600, color: '#cdd6f4', flex: 1 }}>
            {title}{isDirty && ' *'}
          </span>
          <span style={{ fontSize: '11px', color: '#45475a' }}>Ctrl+S save / Esc close</span>
          <button
            onClick={handleSave}
            disabled={!isDirty}
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
            Save
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
      </div>
    </div>
  );
}
