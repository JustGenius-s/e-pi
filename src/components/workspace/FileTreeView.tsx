import { ChevronDown, ChevronRight, Folder, FolderOpen, RefreshCw } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/IconButton";
import { FileTypeIcon } from "@/components/workspace/FileTypeIcon";

import { formatBytes } from "../../lib/format";
import type { AppDescriptor, FileEntry } from "../../types/contracts";

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
  const [apps, setApps] = useState<AppDescriptor[]>([]);
  /** .app bundle path for "打开"; undefined = system default. */
  const [openWithApp, setOpenWithAppState] = useState<string | undefined>(undefined);
  const loadingPaths = useRef(new Set<string>());

  // Load the scanned apps and the persisted "open with" choice once.
  useEffect(() => {
    void Promise.all([window.ePi.app.listApps(), window.ePi.app.getInfo()])
      .then(([scanned, info]) => {
        setApps(scanned);
        setOpenWithAppState(info.openWithApp);
      })
      .catch((reason: unknown) => {
        toast.error(reason instanceof Error ? reason.message : String(reason));
      });
  }, []);

  const persistOpenWithApp = (appPath: string | undefined) => {
    setOpenWithAppState(appPath);
    void window.ePi.app
      .setOpenWithApp(appPath)
      .then((info) => setOpenWithAppState(info.openWithApp))
      .catch((reason: unknown) => {
        toast.error(reason instanceof Error ? reason.message : String(reason));
      });
  };

  /** Open a file with the persisted app; prompts the user when none is chosen. */
  const openFile = async (path: string) => {
    if (!openWithApp) {
      toast.info("未选择默认打开应用，请点击文件树右上角的应用选择器");
      return;
    }
    try {
      await window.ePi.app.openWith(openWithApp, path);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const openFileWith = async (appPath: string, path: string) => {
    try {
      await window.ePi.app.openWith(appPath, path);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    }
  };

  /** "其他…": native app picker, then open with the chosen app. */
  const openFileWithPicker = async (path: string) => {
    try {
      const chosen = await window.ePi.app.chooseApp();
      if (chosen) await window.ePi.app.openWith(chosen, path);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    }
  };

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

  const selectedAppName = apps.find((app) => app.id === openWithApp)?.name;
  const selectedApp = apps.find((app) => app.id === openWithApp);

  const openWithSelector = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="tool-file-open-with-trigger" title="默认打开应用">
          {selectedApp ? appIcon(selectedApp) : null}
          <span className="tool-file-open-with-name">{selectedAppName ?? "选择应用"}</span>
          <ChevronDown size={11} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="tool-file-app-submenu">
        <DropdownMenuLabel>默认打开应用</DropdownMenuLabel>
        {apps.map((app) => (
          <DropdownMenuItem
            key={app.id}
            onSelect={() => persistOpenWithApp(app.id)}
            className={openWithApp === app.id ? "selected" : undefined}
          >
            {appIcon(app)}
            {app.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const renderTree = (node: TreeNode, depth: number): React.ReactNode => {
    const isDir = node.type === "dir";
    const expanded = isDir && node.expanded === true;
    const row = (
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
          <FileTypeIcon name={node.name} />
        )}
        <span className="tool-file-name">{node.name}</span>
        {node.type === "file" && node.size !== undefined ? (
          <span className="tool-file-size">{formatBytes(node.size)}</span>
        ) : null}
      </button>
    );

    const content = isDir ? (
      row
    ) : (
      <ContextMenu>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => void openFile(node.path)}>
            打开
            {selectedAppName ? <span className="tool-file-open-app-hint">{selectedAppName}</span> : null}
          </ContextMenuItem>
          <ContextMenuSub>
            <OpenWithSubMenu
              filePath={node.path}
              fallbackApps={apps}
              onOpenWith={(appId) => void openFileWith(appId, node.path)}
              onOpenOther={() => void openFileWithPicker(node.path)}
            />
          </ContextMenuSub>
        </ContextMenuContent>
      </ContextMenu>
    );

    return (
      <div key={node.path}>
        {depth === 0 ? (
          <div className="tool-file-root-row">
            {content}
            {openWithSelector}
          </div>
        ) : (
          content
        )}
        {expanded ? (node.children ?? []).map((child) => renderTree(child, depth + 1)) : null}
        {isDir && node.loading ? <div className="tool-file-loading">Loading…</div> : null}
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
        <div className="git-empty-panel">Loading…</div>
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

function appIcon(app: AppDescriptor) {
  return app.icon ? <img src={app.icon} className="tool-file-app-icon" alt="" /> : null;
}

/**
 * "打开方式" submenu. Asks the main process which apps are declared to open
 * the file's extension; falls back to the dev-app list while loading or on
 * failure. "其他…" opens the native macOS app picker.
 */
function OpenWithSubMenu({
  filePath,
  fallbackApps,
  onOpenWith,
  onOpenOther,
}: {
  filePath: string;
  fallbackApps: AppDescriptor[];
  onOpenWith: (appId: string) => void;
  onOpenOther: () => void;
}) {
  const [apps, setApps] = useState<AppDescriptor[] | null>(null); // null = loading

  useEffect(() => {
    let cancelled = false;
    const extension = filePath.split(".").pop() ?? "";
    void window.ePi.app
      .appsForExtension(extension)
      .then((result) => {
        if (!cancelled) setApps(result);
      })
      .catch(() => {
        if (!cancelled) setApps(fallbackApps);
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, fallbackApps]);

  return (
    <>
      <ContextMenuSubTrigger>打开方式</ContextMenuSubTrigger>
      <ContextMenuSubContent className="tool-file-app-submenu">
        {apps === null ? (
          <ContextMenuItem disabled>加载中…</ContextMenuItem>
        ) : apps.length === 0 ? (
          <ContextMenuItem disabled>无匹配应用</ContextMenuItem>
        ) : (
          apps.map((app) => (
            <ContextMenuItem key={app.id} onSelect={() => onOpenWith(app.id)}>
              {appIcon(app)}
              {app.name}
            </ContextMenuItem>
          ))
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onOpenOther}>其他…</ContextMenuItem>
      </ContextMenuSubContent>
    </>
  );
}

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
