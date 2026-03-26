import { useState, useCallback, useEffect } from 'react';

type MountPolicy = 'ro' | 'rw' | null | undefined;

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
  mounts: Record<string, MountPolicy>;
  onApply: (mounts: Record<string, MountPolicy>) => void;
  onClose: () => void;
  apiBase?: string;
}

const MAX_DEPTH = 5;

function getMountKeyPrefix(mode: 'project' | 'art'): string {
  return mode === 'project' ? 'project:' : 'art:';
}

function getRootKey(mode: 'project' | 'art'): string {
  return mode === 'project' ? 'project' : 'art';
}

function getApiEndpoint(mode: 'project' | 'art', apiBase: string, dirPath: string): string {
  if (mode === 'project') {
    return dirPath
      ? `${apiBase}/api/project-files?path=${encodeURIComponent(dirPath)}`
      : `${apiBase}/api/project-files`;
  }
  return dirPath
    ? `${apiBase}/api/dirs?path=${encodeURIComponent(dirPath)}`
    : `${apiBase}/api/dirs`;
}

function getEffectivePermission(
  nodePath: string,
  mounts: Record<string, MountPolicy>,
  prefix: string,
  rootKey: string,
): 'ro' | 'rw' | 'disabled' {
  const key = `${prefix}${nodePath}`;
  if (key in mounts) {
    const v = mounts[key];
    if (v === null) return 'disabled';
    if (v === 'ro' || v === 'rw') return v;
  }

  const parts = nodePath.split('/');
  for (let i = parts.length - 1; i >= 1; i--) {
    const ancestorPath = parts.slice(0, i).join('/');
    const ancestorKey = `${prefix}${ancestorPath}`;
    if (ancestorKey in mounts) {
      const v = mounts[ancestorKey];
      if (v === null) return 'disabled';
      if (v === 'ro' || v === 'rw') return v;
    }
  }

  const rootPolicy = mounts[rootKey];
  if (rootPolicy === null) return 'disabled';
  if (rootPolicy === 'rw') return 'rw';
  return 'ro';
}

function getNodeSetting(
  nodePath: string,
  mounts: Record<string, MountPolicy>,
  prefix: string,
): 'inherit' | 'ro' | 'rw' | 'disabled' {
  const key = `${prefix}${nodePath}`;
  if (!(key in mounts)) return 'inherit';
  const v = mounts[key];
  if (v === null) return 'disabled';
  if (v === 'ro') return 'ro';
  if (v === 'rw') return 'rw';
  return 'inherit';
}

function getAllowedOptions(parentEffective: 'rw' | 'ro' | 'disabled'): string[] {
  switch (parentEffective) {
    case 'rw': return ['inherit', 'rw', 'ro', 'disabled'];
    case 'ro': return ['inherit', 'rw', 'ro', 'disabled'];
    case 'disabled': return [];
  }
}

function getParentEffective(
  nodePath: string,
  mounts: Record<string, MountPolicy>,
  prefix: string,
  rootKey: string,
): 'rw' | 'ro' | 'disabled' {
  const parts = nodePath.split('/');
  if (parts.length <= 1) {
    // Parent is root
    const rootPolicy = mounts[rootKey];
    if (rootPolicy === null) return 'disabled';
    if (rootPolicy === 'rw') return 'rw';
    return 'ro';
  }
  const parentPath = parts.slice(0, -1).join('/');
  return getEffectivePermission(parentPath, mounts, prefix, rootKey);
}

/** Reset children whose settings are now invalid after parent permission change */
function resetInvalidChildren(
  mounts: Record<string, MountPolicy>,
  prefix: string,
  rootKey: string,
): Record<string, MountPolicy> {
  const next = { ...mounts };
  for (const key of Object.keys(next)) {
    if (!key.startsWith(prefix)) continue;
    const nodePath = key.slice(prefix.length);
    const parentEff = getParentEffective(nodePath, next, prefix, rootKey);
    const allowed = getAllowedOptions(parentEff);
    const setting = getNodeSetting(nodePath, next, prefix);
    if (setting !== 'inherit' && !allowed.includes(setting)) {
      delete next[key]; // reset to inherit
    }
  }
  return next;
}

function TreeNodeRow({
  node,
  depth,
  mounts,
  prefix,
  rootKey,
  onChange,
  onToggle,
  onLoadChildren,
}: {
  node: TreeNode;
  depth: number;
  mounts: Record<string, MountPolicy>;
  prefix: string;
  rootKey: string;
  onChange: (mounts: Record<string, MountPolicy>) => void;
  onToggle: (path: string) => void;
  onLoadChildren: (path: string) => void;
}) {
  const setting = getNodeSetting(node.path, mounts, prefix);
  const effective = getEffectivePermission(node.path, mounts, prefix, rootKey);
  const parentEff = getParentEffective(node.path, mounts, prefix, rootKey);
  const allowed = getAllowedOptions(parentEff);
  const isDisabledByParent = allowed.length === 0;

  const handleChange = (value: string) => {
    const key = `${prefix}${node.path}`;
    let next = { ...mounts };
    if (value === 'inherit') {
      delete next[key];
    } else if (value === 'disabled') {
      next[key] = null;
    } else {
      next[key] = value as 'ro' | 'rw';
    }
    // Reset invalid children
    next = resetInvalidChildren(next, prefix, rootKey);
    onChange(next);
  };

  const handleToggle = () => {
    if (!node.isDirectory) return;
    if (node.children === null) {
      onLoadChildren(node.path);
    }
    onToggle(node.path);
  };

  const indent = depth * 16;

  return (
    <>
      <div
        className={`mount-overlay-row ${isDisabledByParent ? 'mount-overlay-disabled' : ''}`}
        style={{ paddingLeft: `${indent}px` }}
      >
        <span
          className={`mount-overlay-name ${node.isDirectory ? 'clickable' : ''}`}
          onClick={handleToggle}
        >
          {node.isDirectory && (
            <span className="mount-overlay-arrow">
              {node.expanded ? '▼' : '▶'}{' '}
            </span>
          )}
          {node.name}{node.isDirectory ? '/' : ''}
        </span>
        {!node.isDirectory ? (
          <span className="mount-overlay-dim mount-overlay-file-hint">({effective})</span>
        ) : isDisabledByParent ? (
          <span className="mount-overlay-dim">disabled</span>
        ) : (
          <>
            <select
              className="mount-overlay-select"
              value={setting}
              onChange={(e) => handleChange(e.target.value)}
            >
              {allowed.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
            {setting === 'inherit' && (
              <span className="mount-overlay-effective">({effective})</span>
            )}
          </>
        )}
      </div>
      {node.expanded && node.children && node.children.map((child) => (
        <TreeNodeRow
          key={child.path}
          node={child}
          depth={depth + 1}
          mounts={mounts}
          prefix={prefix}
          rootKey={rootKey}
          onChange={onChange}
          onToggle={onToggle}
          onLoadChildren={onLoadChildren}
        />
      ))}
    </>
  );
}

export function MountOverlay({ mode, title, mounts: initialMounts, onApply, onClose, apiBase = '' }: Props) {
  const [mounts, setMounts] = useState<Record<string, MountPolicy>>({ ...initialMounts });
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(false);

  const prefix = getMountKeyPrefix(mode);
  const rootKey = getRootKey(mode);

  const fetchEntries = useCallback(async (dirPath: string) => {
    const url = getApiEndpoint(mode, apiBase, dirPath);
    const resp = await fetch(url);
    const entries: FileEntry[] = await resp.json();
    return entries.map((e) => ({
      name: e.name,
      path: dirPath ? `${dirPath}/${e.name}` : e.name,
      isDirectory: e.isDirectory,
      children: null as TreeNode[] | null,
      expanded: false,
    }));
  }, [mode, apiBase]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchEntries('').then((entries) => {
      if (!cancelled) setNodes(entries);
    }).catch(() => {}).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [fetchEntries]);

  const loadChildren = useCallback((dirPath: string) => {
    const depth = dirPath.split('/').length;
    if (depth >= MAX_DEPTH) return;
    fetchEntries(dirPath).then((children) => {
      setNodes((prev) => insertChildren(prev, dirPath, children));
    }).catch(() => {});
  }, [fetchEntries]);

  const toggleNode = useCallback((nodePath: string) => {
    setNodes((prev) => toggleExpanded(prev, nodePath));
  }, []);

  const handleApply = () => {
    // Strip file-level project: keys (UI no longer creates them, but saved configs may have them)
    const cleaned: Record<string, MountPolicy> = {};
    for (const [key, value] of Object.entries(mounts)) {
      if (key.startsWith(prefix) && key !== rootKey) {
        const subPath = key.slice(prefix.length);
        const matchingNode = findNode(nodes, subPath);
        if (matchingNode && !matchingNode.isDirectory) continue;
      }
      cleaned[key] = value;
    }
    onApply(cleaned);
    onClose();
  };

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleApply();
  }, [onClose, mounts]);

  const rootPolicy = mounts[rootKey];
  const rootEffective: 'rw' | 'ro' | 'disabled' =
    rootPolicy === null ? 'disabled' : rootPolicy === 'rw' ? 'rw' : 'ro';

  return (
    <div
      className="mount-overlay-backdrop"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div className="mount-overlay-modal">
        {/* Header */}
        <div className="mount-overlay-header">
          <span className="mount-overlay-title">{title}</span>
          <span className="mount-overlay-hint">Esc close / Ctrl+Enter apply</span>
          <button className="mount-overlay-close" onClick={onClose}>✕</button>
        </div>

        {/* Tree body */}
        <div className="mount-overlay-body">
          {loading && nodes.length === 0 && (
            <div className="mount-overlay-loading">Loading...</div>
          )}
          {rootEffective === 'disabled' ? (
            <div className="mount-overlay-loading">Root is disabled — no sub-permissions to configure.</div>
          ) : (
            nodes.map((node) => (
              <TreeNodeRow
                key={node.path}
                node={node}
                depth={0}
                mounts={mounts}
                prefix={prefix}
                rootKey={rootKey}
                onChange={setMounts}
                onToggle={toggleNode}
                onLoadChildren={loadChildren}
              />
            ))
          )}
        </div>

        {/* Footer */}
        <div className="mount-overlay-footer">
          <button className="mount-overlay-btn mount-overlay-btn-cancel" onClick={onClose}>
            취소
          </button>
          <button className="mount-overlay-btn mount-overlay-btn-apply" onClick={handleApply}>
            적용
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

function findNode(nodes: TreeNode[], targetPath: string): TreeNode | null {
  for (const node of nodes) {
    if (node.path === targetPath) return node;
    if (node.children) {
      const found = findNode(node.children, targetPath);
      if (found) return found;
    }
  }
  return null;
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
