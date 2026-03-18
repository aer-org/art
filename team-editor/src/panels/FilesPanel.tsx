import type { AgentFiles } from '../types';

export interface DirInfo {
  name: string;
  files: string[];
}

interface Props {
  files: AgentFiles;
  onChange: (files: AgentFiles) => void;
  artDirs?: DirInfo[];
  onOpenChat?: () => void;
}

const DIR_DESCRIPTIONS: Record<string, string> = {
  plan: 'Agents read this for instructions',
  src: 'Agents write code here',
  tests: 'Test files',
  outputs: 'Build artifacts & eval results',
  metrics: 'Review reports',
  insights: 'Accumulated learnings',
  memory: 'Experiment history',
  logs: 'Debug logs',
};

export function FilesPanel({ artDirs, onOpenChat }: Props) {
  const dirs = artDirs && artDirs.length > 0 ? artDirs : [];

  if (dirs.length === 0) {
    return (
      <div className="panel files-panel">
        <h3>Directories</h3>
        <div className="empty-panel">No directories found</div>
      </div>
    );
  }

  return (
    <div className="panel files-panel">
      <h3>Directories</h3>
      {dirs.map((dir) => (
        <div key={dir.name} className="file-section">
          <div className="file-section-header">
            <span>{dir.name}/</span>
            {dir.files.length > 0 && (
              <span className="file-count">{dir.files.length}</span>
            )}
            {dir.name === 'plan' && onOpenChat && (
              <button className="ai-edit-btn" onClick={onOpenChat}>
                AI edit
              </button>
            )}
          </div>
          {dir.files.length > 0 ? (
            <div className="file-list">
              {dir.files.map((f) => (
                <div key={f} className="file-item">
                  <span className="file-name">{f}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="file-drop-zone file-drop-zone--info">
              {DIR_DESCRIPTIONS[dir.name] ?? 'Empty'}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
