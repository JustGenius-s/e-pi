import { ChevronRight, FileText, Folder, FolderOpen, RefreshCw } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import { IconButton } from "@/components/ui/IconButton";

import { formatBytes } from "../../lib/format";
import type { FileEntry } from "../../types/contracts";

interface FileTreeViewProps {
  cwd: string;
}

interface TreeNode extends FileEntry {
  children?: TreeNode[];
  expanded?: boolean;
  loading?: boolean;
  error?: string;
}

function treeNode(entry: FileEntry): TreeNode {
  return { ...entry };
}

/** Lazy directory tree. */
export const FileTreeView = memo(function FileTreeView({ cwd }: FileTreeViewProps) {
  const [root, setRoot] = useState<TreeNode>();
  const [rootError, setRootError] = useState<string>();
  const loadingPaths = useRef(new Set<string>());

  const loadDir = useCallback(
    async (path: string, onLoaded: (entries: FileEntry[]) => void, onError: (message: string) => void) => {
      loadingPaths.current.add(path);
      try {
        onLoaded(await window.ePi.fs.listDir(cwd, path));
      } catch (reason) {
        onError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        loadingPaths.current.delete(path);
      }
    },
    [cwd],
  );

  // Load the root directory.
  useEffect(() => {
    setRoot(undefined);
    setRootError(undefined);
    void loadDir(
      cwd,
      (entries) =>
        setRoot({
          name: cwd.split("/").pop() || cwd,
          path: cwd,
          type: "dir",
          expanded: true,
          children: entries.map(treeNode),
        }),
      setRootError,
    );
  }, [cwd, loadDir]);

  const toggle = (node: TreeNode) => {
    if (node.type === "file") return;
    if (node.children) {
      // Toggle: expand if collapsed, collapse if expanded; keep children
      // cached so reopening is instant.
      const willExpand = node.expanded !== true;
      setRoot((current) => expandPath(current, node.path, willExpand));
      return;
    }
    // Lazy-load children.
    setRoot((current) => expandPath(current, node.path, true, true));
    void loadDir(
      node.path,
      (entries) => setRoot((current) => expandPath(current, node.path, true, false, entries.map(treeNode))),
      (message) => setRoot((current) => expandPath(current, node.path, true, false, undefined, message)),
    );
  };

  const renderTree = (node: TreeNode, depth: number): React.ReactNode => {
    const isDir = node.type === "dir";
    const expanded = isDir && node.expanded === true;
    return (
      <div key={node.path}>
        <button
          type="button"
          className="tool-file-row"
          style={{ paddingLeft: `${8 + depth * 12}px` }}
          onClick={() => toggle(node)}
        >
          <span className="tool-file-chevron">
            {isDir ? <ChevronRight size={11} className={expanded ? "rotated" : ""} /> : null}
          </span>
          {isDir ? (
            expanded ? (
              <FolderOpen size={13} className="tool-file-dir-icon" />
            ) : (
              <Folder size={13} className="tool-file-dir-icon" />
            )
          ) : (
            <FileText size={13} className="tool-file-file-icon" />
          )}
          <span className="tool-file-name">{node.name}</span>
          {node.type === "file" && node.size !== undefined ? (
            <span className="tool-file-size">{formatBytes(node.size)}</span>
          ) : null}
        </button>
        {expanded ? (node.children ?? []).map((child) => renderTree(child, depth + 1)) : null}
        {isDir && node.loading ? <div className="tool-file-loading">加载中…</div> : null}
        {isDir && node.error ? <div className="tool-file-error">{node.error}</div> : null}
      </div>
    );
  };

  return (
    <div className="git-panel-body">
      {rootError ? <div className="git-error">{rootError}</div> : null}

      {root ? (
        <div className="tool-file-tree">{renderTree(root, 0)}</div>
      ) : (
        <div className="git-empty-panel">加载中…</div>
      )}
      <div className="tool-view-bar">
        <IconButton
          label="Refresh"
          onClick={() => {
            setRoot(undefined);
            void loadDir(
              cwd,
              (entries) =>
                setRoot({
                  name: cwd.split("/").pop() || cwd,
                  path: cwd,
                  type: "dir",
                  expanded: true,
                  children: entries.map(treeNode),
                }),
              setRootError,
            );
          }}
        >
          <RefreshCw size={13} />
        </IconButton>
      </div>
    </div>
  );
});

/** Immutably update the node at `path`: expand/collapse and optionally set children/loading/error. */
function expandPath(
  node: TreeNode | undefined,
  path: string,
  expanded: boolean,
  loading = false,
  children?: TreeNode[],
  error?: string,
): TreeNode | undefined {
  if (!node) return node;
  if (node.path === path) {
    return {
      ...node,
      expanded,
      loading,
      error: error ?? node.error,
      children: children ?? node.children,
    };
  }
  if (!node.children) return node;
  return {
    ...node,
    children: node.children.flatMap((child) => {
      const updated = expandPath(child, path, expanded, loading, children, error);
      return updated ? [updated] : [];
    }),
  };
}
