export interface ProjectFile {
  name: string;
  isDirectory: boolean;
}

interface Props {
  files: ProjectFile[];
}

export function ProjectsPanel({ files }: Props) {
  if (files.length === 0) {
    return (
      <div className="panel files-panel">
        <h3>Projects</h3>
        <div className="empty-panel">No project files found</div>
      </div>
    );
  }

  return (
    <div className="panel files-panel">
      <h3>Projects</h3>
      <div className="file-list">
        {files.map((f) => (
          <div key={f.name} className="file-item">
            <span className="file-name">{f.isDirectory ? `${f.name}/` : f.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
