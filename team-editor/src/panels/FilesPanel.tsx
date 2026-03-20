import { useState } from 'react';
import type { AgentFiles } from '../types';
import { DirBrowserOverlay } from '../components/DirBrowserOverlay';

export interface DirInfo {
  name: string;
  files: string[];
}

export interface ProjectFile {
  name: string;
  isDirectory: boolean;
}

interface Props {
  files: AgentFiles;
  onChange: (files: AgentFiles) => void;
  artDirs?: DirInfo[];
  projectFiles?: ProjectFile[];
  onOpenChat?: () => void;
  onOpenFile?: (relativePath: string) => void;
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

export function FilesPanel({ artDirs, projectFiles, onOpenChat, onOpenFile }: Props) {
  const [browserMode, setBrowserMode] = useState<'project' | 'art' | null>(null);
  const dirs = artDirs && artDirs.length > 0 ? artDirs : [];

  return (
    <div className="panel files-panel">
      <h3>Directories</h3>

      {/* Project Folder group */}
      <div className="dir-group">
        <div className="dir-group-header">
          <span className="dir-group-label">Project Folder</span>
        </div>
        <div className="dir-group-summary">
          {projectFiles && projectFiles.length > 0
            ? `${projectFiles.length} items`
            : 'No project files'}
        </div>
        <button className="dir-browse-btn" onClick={() => setBrowserMode('project')}>
          Browse
        </button>
      </div>

      {/* Agent Managed Folder group */}
      <div className="dir-group">
        <div className="dir-group-header">
          <span className="dir-group-label">Agent Managed Folder</span>
        </div>
        {dirs.length > 0 ? (
          <div className="dir-group-dirs">
            {[...dirs].sort((a, b) => (a.files.length === 0 ? 1 : 0) - (b.files.length === 0 ? 1 : 0)).map((dir) => (
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
                {dir.files.length === 0 && (
                  <div className="file-drop-zone file-drop-zone--info">
                    {DIR_DESCRIPTIONS[dir.name] ?? 'Empty'}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="dir-group-summary">No directories found</div>
        )}
        <button className="dir-browse-btn" onClick={() => setBrowserMode('art')}>
          Browse
        </button>
      </div>

      {/* Overlay */}
      {browserMode && (
        <DirBrowserOverlay
          mode={browserMode}
          title={browserMode === 'project' ? 'Project Folder' : 'Agent Managed Folder'}
          onOpenFile={onOpenFile}
          onClose={() => setBrowserMode(null)}
          artDirs={artDirs}
        />
      )}
    </div>
  );
}
