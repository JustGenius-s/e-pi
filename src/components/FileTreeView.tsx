import { ChevronRight, FileText, Folder, FolderOpen, LayoutPanelLeft, RefreshCw } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import { formatBytes } from "../lib/format";
import type { FileContentResult, FileEntry } from "../types/contracts";
import { IconButton } from "./IconButton";

interface FileTreeViewProps {
  cwd: string;
  onBack: () => void;
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

/** Lazy directory tree with a preview pane for files. */
export const FileTreeView = memo(function FileTreeView({ cwd, onBack }: FileTreeViewProps) {
  const [root, setRoot] = useState<TreeNode>();
  const [rootError, setRootError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [preview, setPreview] = useState<FileContentResult>();
  const [previewError, setPreviewError] = useState<string>();
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
    setSelected(undefined);
    setPreview(undefined);
    setPreviewError(undefined);
    setRootError(undefined);
    void loadDir(
      cwd,
      (entries) =>
        setRoot({ name: cwd.split("/").pop() || cwd, path: cwd, type: "dir", children: entries.map(treeNode) }),
      setRootError,
    );
  }, [cwd, loadDir]);

  // Load file preview when a file is selected.
  useEffect(() => {
    if (!selected) {
      setPreview(undefined);
      return;
    }
    let cancelled = false;
    setPreview(undefined);
    setPreviewError(undefined);
    void window.ePi.fs
      .readFile(cwd, selected)
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setPreviewError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, selected]);

  const toggle = (node: TreeNode) => {
    if (node.type === "file") {
      setSelected(node.path);
      return;
    }
    if (node.children) {
      // Collapse; keep children cached so reopening is instant.
      setRoot((current) => expandPath(current, node.path, false));
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
    const isSelected = node.type === "file" && node.path === selected;
    return (
      <div key={node.path}>
        <button
          type="button"
          className={`tool-file-row${isSelected ? " selected" : ""}`}
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
        <>
          <div className="tool-file-tree">{renderTree(root, 0)}</div>
          <div className="tool-file-preview">
            {preview ? (
              <>
                <div className="tool-file-preview-head">{selected?.split("/").pop()}</div>
                <pre className="tool-file-preview-content">{preview.content}</pre>
              </>
            ) : previewError ? (
              <div className="tool-file-preview-empty">{previewError}</div>
            ) : (
              <div className="tool-file-preview-empty">选择一个文件查看内容</div>
            )}
          </div>
        </>
      ) : (
        <div className="git-empty-panel">加载中…</div>
      )}
      <div className="tool-view-bar">
        <button type="button" className="tool-view-bar-back" onClick={onBack}>
          <LayoutPanelLeft size={12} />
          内容列表
        </button>
        <IconButton
          label="Refresh"
          onClick={() => {
            setRoot(undefined);
            void loadDir(
              cwd,
              (entries) =>
                setRoot({ name: cwd.split("/").pop() || cwd, path: cwd, type: "dir", children: entries.map(treeNode) }),
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
