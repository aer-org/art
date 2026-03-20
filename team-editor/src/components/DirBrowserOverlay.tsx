import { useState, useCallback, useEffect } from 'react';

interface FileEntry {
  name: string;
  isDirectory: boolean;
}

interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children: TreeNode[] | null;
  expanded: boolean;
}

interface Props {
  mode: 'project' | 'art';
  title: string;
  onOpenFile?: (relativePath: string) => void;
  onClose: () => void;
  artDirs?: { name: string; files: string[] }[];
  apiBase?: string;
}

const MAX_DEPTH = 5;

function getApiEndpoint(apiBase: string, dirPath: string): string {
  return dirPath
    ? `${apiBase}/api/project-files?path=${encodeURIComponent(dirPath)}`
    : `${apiBase}/api/project-files`;
}

function buildArtTree(dirs: { name: string; files: string[] }[]): TreeNode[] {
  return dirs.map((dir) => ({
    name: dir.name,
    path: dir.name,
    isDirectory: true,
    expanded: false,
    children: dir.files.map((f) => ({
      name: f,
      path: `${dir.name}/${f}`,
      isDirectory: false,
      children: null,
      expanded: false,
    })),
  }));
}

function TreeRow({
  node,
  depth,
  onToggle,
  onLoadChildren,
  onOpenFile,
}: {
  node: TreeNode;
  depth: number;
  onToggle: (path: string) => void;
  onLoadChildren: (path: string) => void;
  onOpenFile?: (path: string) => void;
}) {
  const indent = depth * 16;

  const handleClick = () => {
    if (node.isDirectory) {
      if (node.children === null) {
        onLoadChildren(node.path);
      }
      onToggle(node.path);
    } else {
      onOpenFile?.(node.path);
    }
  };

  return (
    <>
      <div
        className="dir-browser-row"
        style={{ paddingLeft: `${indent + 12}px` }}
        onClick={handleClick}
      >
        {node.isDirectory ? (
          <span className="dir-browser-icon dir-browser-icon-dir">
            {node.expanded ? '▼' : '▶'}
          </span>
        ) : (
          <span className="dir-browser-icon dir-browser-icon-file" />
        )}
        <span className={`dir-browser-name ${!node.isDirectory && onOpenFile ? 'dir-browser-clickable-file' : ''}`}>
          {node.name}{node.isDirectory ? '/' : ''}
        </span>
      </div>
      {node.expanded && node.children && node.children.map((child) => (
        <TreeRow
          key={child.path}
          node={child}
          depth={depth + 1}
          onToggle={onToggle}
          onLoadChildren={onLoadChildren}
          onOpenFile={onOpenFile}
        />
      ))}
    </>
  );
}

export function DirBrowserOverlay({ mode, title, onOpenFile, onClose, artDirs, apiBase = '' }: Props) {
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchEntries = useCallback(async (dirPath: string) => {
    const url = getApiEndpoint(apiBase, dirPath);
    const resp = await fetch(url);
    const entries: FileEntry[] = await resp.json();
    return entries.map((e) => ({
      name: e.name,
      path: dirPath ? `${dirPath}/${e.name}` : e.name,
      isDirectory: e.isDirectory,
      children: null as TreeNode[] | null,
      expanded: false,
    }));
  }, [apiBase]);

  useEffect(() => {
    if (mode === 'art') {
      setNodes(buildArtTree(artDirs ?? []));
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchEntries('').then((entries) => {
      if (!cancelled) setNodes(entries);
    }).catch(() => {}).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [mode, fetchEntries, artDirs]);

  const loadChildren = useCallback((dirPath: string) => {
    if (mode === 'art') return; // art tree is pre-built
    const depth = dirPath.split('/').length;
    if (depth >= MAX_DEPTH) return;
    fetchEntries(dirPath).then((children) => {
      setNodes((prev) => insertChildren(prev, dirPath, children));
    }).catch(() => {});
  }, [mode, fetchEntries]);

  const toggleNode = useCallback((nodePath: string) => {
    setNodes((prev) => toggleExpanded(prev, nodePath));
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  const handleFileClick = useCallback((path: string) => {
    onOpenFile?.(path);
    onClose();
  }, [onOpenFile, onClose]);

  return (
    <div
      className="mount-overlay-backdrop"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div className="mount-overlay-modal">
        <div className="mount-overlay-header">
          <span className="mount-overlay-title">{title}</span>
          <button className="mount-overlay-close" onClick={onClose}>✕</button>
        </div>

        <div className="mount-overlay-body">
          {loading && nodes.length === 0 && (
            <div className="mount-overlay-loading">Loading...</div>
          )}
          {!loading && nodes.length === 0 && (
            <div className="mount-overlay-loading">No files found</div>
          )}
          {nodes.map((node) => (
            <TreeRow
              key={node.path}
              node={node}
              depth={0}
              onToggle={toggleNode}
              onLoadChildren={loadChildren}
              onOpenFile={onOpenFile ? handleFileClick : undefined}
            />
          ))}
        </div>

        <div className="mount-overlay-footer">
          <button className="mount-overlay-btn mount-overlay-btn-cancel" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Tree helpers ---

function insertChildren(
  nodes: TreeNode[],
  parentPath: string,
  children: TreeNode[],
): TreeNode[] {
  return nodes.map((node) => {
    if (node.path === parentPath) {
      return { ...node, children, expanded: true };
    }
    if (node.children) {
      return { ...node, children: insertChildren(node.children, parentPath, children) };
    }
    return node;
  });
}

function toggleExpanded(nodes: TreeNode[], targetPath: string): TreeNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath) {
      return { ...node, expanded: !node.expanded };
    }
    if (node.children) {
      return { ...node, children: toggleExpanded(node.children, targetPath) };
    }
    return node;
  });
}
