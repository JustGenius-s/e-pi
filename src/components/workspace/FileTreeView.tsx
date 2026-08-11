import { ChevronDown, ChevronRight, Folder, FolderOpen, Loader2, RefreshCw, Search, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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

import { emitAttachFiles } from "../../lib/attachmentsBus";
import {
  displayHitPath,
  expandPath,
  findNodeIn,
  refreshDirChildren,
  rootIndexOf,
  treeNode,
  updateRoot,
  type TreeNode,
} from "../../lib/file-tree";
import { formatBytes } from "../../lib/format";
import { isWorkspacePreviewPath } from "../../lib/workspacePreviewKind";
import type { AppDescriptor, FileEntry, MentionSearchEntry } from "../../types/contracts";

const SEARCH_DEBOUNCE_MS = 180;

interface FileTreeViewProps {
  cwd: string;
  /**
   * Project repos (multi-repo workspaces): each repo becomes a collapsible
   * root in the tree. Undefined/empty falls back to a single root at `cwd`.
   */
  roots?: string[];
  /** Open a workspace file through the preview/editor routing. */
  onOpenFile?: (path: string, imagePaths?: string[]) => void;
}

/** A workspace-search hit; `path` is absolute (root-prefixed) for multi-repo trees. */
interface SearchHit extends MentionSearchEntry {
  root: string;
}

function isImagePath(path: string) {
  return /\.(avif|bmp|gif|ico|jpeg|jpg|png|svg|webp)$/i.test(path);
}

/** Lazy directory tree (single root, or one collapsible root per project repo) with search, watcher-driven refresh and preview/editor opening. */
export const FileTreeView = memo(function FileTreeView({ cwd, roots, onOpenFile }: FileTreeViewProps) {
  /** Multi-root only when the project contributes ≥2 repos; single root otherwise. */
  const multiRoot = (roots?.length ?? 0) > 1;
  const treeRoots = useMemo(() => {
    const resolved = roots && roots.length > 0 ? roots : [cwd];
    // The session's own repo comes first; the rest keep project order.
    return [...resolved].sort((a, b) => (a === cwd ? -1 : b === cwd ? 1 : 0));
  }, [roots, cwd]);
  const rootSet = useMemo(() => new Set(treeRoots), [treeRoots]);
  /** One root node per repo; all path operations resolve against their own root. */
  const [rootsState, setRootsState] = useState<TreeNode[]>([]);
  const [rootError, setRootError] = useState<string>();
  const [apps, setApps] = useState<AppDescriptor[]>([]);
  /** .app bundle path for "Open"; undefined = system default. */
  const [openWithApp, setOpenWithAppState] = useState<string | undefined>(undefined);
  const [platform, setPlatform] = useState<NodeJS.Platform>("darwin");
  /** Path of the last clicked/right-clicked row, kept highlighted. */
  const [selectedPath, setSelectedPath] = useState<string>();
  /** Search box state. */
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searchError, setSearchError] = useState<string>();
  const loadingPaths = useRef(new Set<string>());

  // Load the scanned apps, the persisted "open with" choice and the platform once.
  useEffect(() => {
    void Promise.all([window.ePi.app.listApps(), window.ePi.app.getInfo()])
      .then(([scanned, info]) => {
        setApps(scanned);
        setOpenWithAppState(info.openWithApp);
        setPlatform(info.platform);
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
  const openFile = useCallback(
    async (path: string) => {
      if (!openWithApp) {
        toast.info("No default app chosen; pick one from the app selector in the file tree");
        return;
      }
      try {
        await window.ePi.app.openWith(openWithApp, path);
      } catch (reason) {
        toast.error(reason instanceof Error ? reason.message : String(reason));
      }
    },
    [openWithApp],
  );

  const openFileWith = async (appPath: string, path: string) => {
    try {
      await window.ePi.app.openWith(appPath, path);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    }
  };

  /** "Other…": native app picker, then open with the chosen app. */
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
        // The containing root is the workspace root for path validation.
        const index = rootIndexOf(rootsState, path);
        const rootPath = index >= 0 ? rootsState[index].path : treeRoots.find((r) => path.startsWith(`${r}/`)) ?? cwd;
        onLoaded(await window.ePi.fs.listDir(rootPath, path));
      } catch (reason) {
        onError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        loadingPaths.current.delete(path);
      }
    },
    [cwd, rootsState, treeRoots],
  );

  // Load every root (one per repo; a single root for standalone folders).
  useEffect(() => {
    let cancelled = false;
    setRootsState([]);
    setRootError(undefined);
    setQuery("");
    setSearchResults([]);
    void (async () => {
      const loaded = await Promise.all(
        treeRoots.map(async (rootPath) => {
          const name = rootPath.split("/").pop() || rootPath;
          try {
            const entries = await window.ePi.fs.listDir(rootPath, rootPath);
            return {
              name,
              path: rootPath,
              type: "dir" as const,
              expanded: true,
              children: entries.map(treeNode),
            } satisfies TreeNode;
          } catch (reason) {
            return {
              name,
              path: rootPath,
              type: "dir" as const,
              expanded: true,
              error: reason instanceof Error ? reason.message : String(reason),
            } satisfies TreeNode;
          }
        }),
      );
      if (cancelled) return;
      setRootsState(loaded);
      // Surface a global error only when every root failed to load.
      if (loaded.length > 0 && loaded.every((node) => node.error)) {
        setRootError(loaded[0].error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [treeRoots]);

  const toggle = (node: TreeNode) => {
    if (node.type === "file") return;
    if (node.children) {
      // Toggle: expand if collapsed, collapse if expanded; keep children
      // cached so reopening is instant.
      const willExpand = node.expanded !== true;
      setRootsState((current) => updateRoot(current, node.path, (root) => expandPath(root, node.path, willExpand)!));
      return;
    }
    // Lazy-load children.
    setRootsState((current) => updateRoot(current, node.path, (root) => expandPath(root, node.path, true, true)!));
    void loadDir(
      node.path,
      (entries) =>
        setRootsState((current) =>
          updateRoot(current, node.path, (root) => expandPath(root, node.path, true, false, entries.map(treeNode))!),
        ),
      (message) =>
        setRootsState((current) =>
          updateRoot(current, node.path, (root) => expandPath(root, node.path, true, false, undefined, message)!),
        ),
    );
  };

  /** Reload the directory at `path`, keeping the rest of the tree intact. */
  const reloadDir = useCallback(
    (path: string) => {
      setRootsState((current) => {
        const node = findNodeIn(current, path);
        if (!node || node.type !== "dir" || node.expanded !== true) return current;
        void loadDir(
          path,
          (entries) =>
            setRootsState((tree) => updateRoot(tree, path, (root) => refreshDirChildren(root, path, entries.map(treeNode))!)),
          (_message) =>
            setRootsState((tree) => updateRoot(tree, path, (root) => refreshDirChildren(root, path, node.children ?? [])!)),
        );
        return current;
      });
    },
    [loadDir],
  );

  // Watcher-driven refresh: reload expanded directories touched by changes.
  useEffect(() => {
    return window.ePi.workspace.onChanged((event) => {
      // Only events inside one of the tree roots (each repo watches its own
      // cwd, so multi-repo changes arrive with the repo that changed).
      if (!rootSet.has(event.cwd)) return;
      const targets = new Set<string>();
      for (const changed of event.paths) {
        if (!changed) {
          targets.add(event.cwd);
          continue;
        }
        const parts = changed.split("/");
        parts.pop(); // parent directory of the changed path
        targets.add(parts.length > 0 ? `${event.cwd}/${parts.join("/")}` : event.cwd);
      }
      for (const target of targets) reloadDir(target);
    });
  }, [rootSet, reloadDir]);

  // Debounced search across all tree roots (multi-repo: one search per repo).
  useEffect(() => {
    if (!query.trim()) {
      setSearchResults([]);
      setSearchError(undefined);
      setSearchTruncated(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearching(true);
      void (async () => {
        const trimmed = query.trim();
        const hits: SearchHit[] = [];
        let truncated = false;
        let failures = 0;
        for (const rootPath of treeRoots) {
          try {
            const result = await window.ePi.fs.mentionSearch(rootPath, trimmed);
            for (const entry of result.entries) {
              hits.push({ ...entry, path: `${rootPath}/${entry.path}`, root: rootPath });
            }
            truncated ||= result.truncated;
          } catch {
            failures += 1;
          }
        }
        if (cancelled) return;
        setSearchResults(hits);
        setSearchTruncated(truncated);
        setSearchError(failures === treeRoots.length ? `Search failed in ${failures} repo(s)` : undefined);
        setSearching(false);
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [treeRoots, query]);

  /** Reveal a search result: expand ancestors, select and (for files) open. */
  const revealResult = (hit: SearchHit) => {
    const absPath = hit.path;
    setQuery("");
    setSearchResults([]);
    setSelectedPath(absPath);
    if (hit.kind === "file") {
      if (onOpenFile) {
        onOpenFile(absPath);
        return;
      }
      void openFile(absPath);
      return;
    }
    // Directory: expand the ancestor chain lazily within its root.
    const rel = absPath.startsWith(`${hit.root}/`) ? absPath.slice(hit.root.length + 1) : absPath;
    const parts = rel.split("/");
    const chain: string[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      chain.push(`${hit.root}/${parts.slice(0, index + 1).join("/")}`);
    }
    void (async () => {
      for (const dir of chain) {
        const node = findNodeIn(rootsState, dir);
        if (node?.children) {
          setRootsState((current) => updateRoot(current, dir, (root) => expandPath(root, dir, true)!));
        } else {
          setRootsState((current) => updateRoot(current, dir, (root) => expandPath(root, dir, true, true)!));
          await loadDir(
            dir,
            (entries) =>
              setRootsState((current) =>
                updateRoot(current, dir, (root) => expandPath(root, dir, true, false, entries.map(treeNode))!),
              ),
            () => undefined,
          );
        }
      }
    })();
  };

  const handleOpenFile = useCallback(
    (path: string) => {
      if (!onOpenFile) {
        void openFile(path);
        return;
      }
      // Sibling image paths for prev/next navigation in the preview overlay.
      const node = findNodeIn(rootsState, path);
      const parentPath = path.slice(0, path.lastIndexOf("/"));
      const parent = findNodeIn(rootsState, parentPath);
      const siblingImages =
        parent?.children
          ?.filter((child) => child.type === "file" && isImagePath(child.path))
          .map((child) => child.path) ?? [];
      onOpenFile(path, siblingImages.length > 0 ? siblingImages : undefined);
      void node;
    },
    [onOpenFile, openFile, rootsState],
  );

  const selectedAppName = apps.find((app) => app.id === openWithApp)?.name;
  const selectedApp = apps.find((app) => app.id === openWithApp);

  const openWithSelector = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="tool-file-open-with-trigger" title="Default open-with app">
          {selectedApp ? appIcon(selectedApp) : null}
          <span className="tool-file-open-with-name">{selectedAppName ?? "Choose app"}</span>
          <ChevronDown size={11} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="tool-file-app-submenu">
        <DropdownMenuLabel>Default open-with app</DropdownMenuLabel>
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

  const fileManagerLabel = platform === "darwin" ? "Finder" : platform === "win32" ? "File Explorer" : "File Manager";

  /** Attach a file or folder to the composer via the attachments bus. */
  const addToConversation = (path: string) => {
    emitAttachFiles([path]);
    toast.info(`Added to chat: ${path.split(/[\\/]/).pop()}`);
  };

  const renderTree = (node: TreeNode, depth: number): React.ReactNode => {
    const isDir = node.type === "dir";
    const expanded = isDir && node.expanded === true;
    const row = (
      <button
        type="button"
        className={`tool-file-row${selectedPath === node.path ? " selected" : ""}`}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        onClick={() => toggle(node)}
        onDoubleClick={() => {
          if (!isDir) handleOpenFile(node.path);
        }}
        onContextMenu={() => setSelectedPath(node.path)}
      >
        <span className="tool-file-chevron">
          {isDir ? <ChevronRight size={11} className={expanded ? "rotated" : undefined} /> : null}
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
        <span className="tool-file-name" title={node.name}>
          {node.name}
        </span>
        {node.type === "file" && node.size !== undefined ? (
          <span className="tool-file-size">{formatBytes(node.size)}</span>
        ) : null}
      </button>
    );

    const canPreview = !isDir && isWorkspacePreviewPath(node.path);
    const content = isDir ? (
      <ContextMenu>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => void window.ePi.app.openPath(node.path)}>
            Open in {fileManagerLabel}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => addToConversation(node.path)}>Add to Chat</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    ) : (
      <ContextMenu>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        <ContextMenuContent>
          {canPreview ? (
            <ContextMenuItem onSelect={() => handleOpenFile(node.path)}>Preview</ContextMenuItem>
          ) : (
            <ContextMenuItem onSelect={() => handleOpenFile(node.path)}>Open in Editor</ContextMenuItem>
          )}
          <ContextMenuItem onSelect={() => void openFile(node.path)}>
            Open
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
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => void window.ePi.app.showInFolder(node.path)}>
            Show in {fileManagerLabel}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => addToConversation(node.path)}>Add to Chat</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );

    return (
      <div key={node.path}>
        {depth === 0 ? (
          <div className="tool-file-root-row">
            {content}
            {multiRoot ? null : openWithSelector}
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

  const showSearch = query.trim().length > 0;

  return (
    <div className="git-panel-body">
      {rootError ? <div className="git-error">{rootError}</div> : null}

      <div className="tool-file-search">
        <Search size={12} className="tool-file-search-icon" />
        <input
          type="text"
          className="tool-file-search-input"
          placeholder={multiRoot ? "Search project repos…" : "Search workspace…"}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setQuery("");
              setSearchResults([]);
            }
          }}
        />
        {multiRoot ? openWithSelector : null}
        {searching ? (
          <Loader2 size={12} className="tool-file-search-spinner spin" />
        ) : query ? (
          <button
            type="button"
            className="tool-file-search-clear"
            aria-label="Clear search"
            onClick={() => {
              setQuery("");
              setSearchResults([]);
            }}
          >
            <X size={11} />
          </button>
        ) : null}
      </div>

      {showSearch ? (
        <div className="tool-file-search-results">
          {searchError ? (
            <div className="tool-file-error">{searchError}</div>
          ) : searchResults.length === 0 && !searching ? (
            <div className="tool-file-search-empty">No matches</div>
          ) : (
            searchResults.map((entry) => (
              <button
                key={`${entry.kind}:${entry.path}`}
                type="button"
                className="tool-file-search-result"
                title={entry.path}
                onClick={() => revealResult(entry)}
              >
                {entry.kind === "dir" ? <Folder size={12} /> : <FileTypeIcon name={entry.name} />}
                <span className="min-w-0 flex-1 truncate text-left">{displayHitPath(entry.path, entry.root, multiRoot)}</span>
              </button>
            ))
          )}
          {searchTruncated ? <div className="tool-file-search-truncated">Results truncated</div> : null}
        </div>
      ) : null}

      {rootsState.length > 0 ? (
        <div className="tool-file-tree">
          {rootsState.map((rootNode) => (
            <div key={rootNode.path}>
              {renderTree(rootNode, 0)}
              {multiRoot ? <div className="tool-file-root-divider" /> : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="git-empty-panel">Loading…</div>
      )}
      <div className="tool-view-bar">
        <IconButton
          label="Refresh"
          onClick={() => {
            void (async () => {
              const loaded = await Promise.all(
                treeRoots.map(async (rootPath) => {
                  const name = rootPath.split("/").pop() || rootPath;
                  try {
                    const entries = await window.ePi.fs.listDir(rootPath, rootPath);
                    return {
                      name,
                      path: rootPath,
                      type: "dir" as const,
                      expanded: true,
                      children: entries.map(treeNode),
                    } satisfies TreeNode;
                  } catch (reason) {
                    return {
                      name,
                      path: rootPath,
                      type: "dir" as const,
                      expanded: true,
                      error: reason instanceof Error ? reason.message : String(reason),
                    } satisfies TreeNode;
                  }
                }),
              );
              setRootsState(loaded);
              if (loaded.length > 0 && loaded.every((node) => node.error)) {
                setRootError(loaded[0].error);
              } else {
                setRootError(undefined);
              }
            })();
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
 * "Open With" submenu. Asks the main process which apps are declared to open
 * the file's extension; falls back to the dev-app list while loading or on
 * failure. "Other…" opens the native macOS app picker.
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
      <ContextMenuSubTrigger>Open With</ContextMenuSubTrigger>
      <ContextMenuSubContent className="tool-file-app-submenu">
        {apps === null ? (
          <ContextMenuItem disabled>Loading…</ContextMenuItem>
        ) : apps.length === 0 ? (
          <ContextMenuItem disabled>No matching apps</ContextMenuItem>
        ) : (
          apps.map((app) => (
            <ContextMenuItem key={app.id} onSelect={() => onOpenWith(app.id)}>
              {appIcon(app)}
              {app.name}
            </ContextMenuItem>
          ))
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onOpenOther}>Other…</ContextMenuItem>
      </ContextMenuSubContent>
    </>
  );
}
