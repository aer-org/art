import { useDocumentPoller } from '../hooks/useDocumentPoller';
import './DocumentPanel.css';

// ── Simple markdown rendering ──

function renderMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/^\d+\. (.+)$/gm, '<div class="doc-list-item">$&</div>')
    .replace(/^- (.+)$/gm, '<div class="doc-list-item">$&</div>')
    .replace(/\n/g, '<br/>');
}

// ── Simple line-by-line diff ──

interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  text: string;
}

function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const result: DiffLine[] = [];
  const maxLen = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < maxLen; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : undefined;
    const newLine = i < newLines.length ? newLines[i] : undefined;

    if (oldLine === undefined) {
      result.push({ type: 'added', text: newLine! });
    } else if (newLine === undefined) {
      result.push({ type: 'removed', text: oldLine });
    } else if (oldLine !== newLine) {
      result.push({ type: 'removed', text: oldLine });
      result.push({ type: 'added', text: newLine });
    } else {
      result.push({ type: 'unchanged', text: newLine });
    }
  }

  return result;
}

function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const lines = computeDiff(oldText, newText);
  return (
    <div className="doc-diff">
      {lines.map((line, i) => (
        <div key={i} className={`doc-diff-line doc-diff-line--${line.type}`}>
          <span className="doc-diff-prefix">
            {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
          </span>
          <span>{line.text || '\u00A0'}</span>
        </div>
      ))}
    </div>
  );
}

// ── Main Component ──

export function DocumentPanel({
  title,
  path,
}: {
  title: string;
  path: string;
}) {
  const { content, prevContent, hasChanged, isLoading } =
    useDocumentPoller(path);

  return (
    <div className="doc-panel">
      <div className="doc-panel-header">
        <span className="doc-panel-title">{title}</span>
        {hasChanged && <span className="doc-panel-badge">Updated</span>}
      </div>
      <div className="doc-panel-body">
        {isLoading ? (
          <div className="doc-placeholder">Loading...</div>
        ) : content === null ? (
          <div className="doc-placeholder">Waiting for agent...</div>
        ) : hasChanged && prevContent !== null ? (
          <DiffView oldText={prevContent} newText={content} />
        ) : (
          <div
            className="doc-rendered"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
          />
        )}
      </div>
    </div>
  );
}
