import { Terminal, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { PackagePanel } from "@/components/panels/PackagePanel";
import { AppDialogs } from "@/components/settings/AppDialogs";
import { ImportMultiRepoDialog } from "@/components/settings/ImportMultiRepoDialog";
import { IconButton } from "@/components/ui/IconButton";
import { SidebarInset, SidebarProvider, SidebarRail, Sidebar } from "@/components/ui/sidebar";
import { AppHeader } from "@/components/workspace/AppHeader";
import { Composer } from "@/components/workspace/Composer";
import { SessionSidebar } from "@/components/workspace/SessionSidebar";
import { SkillPanel } from "@/components/workspace/SkillPanel";
import { TerminalPanel } from "@/components/workspace/TerminalPanel";
import { ToolPanel } from "@/components/workspace/ToolPanel";
import type { PanelState, PanelTab, PanelView } from "@/components/workspace/ToolPanel";
import { WorkspaceOverlayHost } from "@/components/workspace/WorkspaceOverlayHost";
import { clearAllTerminalBuffers, clearTerminalBuffer } from "@/lib/terminalReplayStore";

import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { useSessionRuntime } from "./hooks/useSessionRuntime";
import { useUnseenRunCompletions } from "./hooks/useUnseenRunCompletions";
import { restoreWorkspaceOverlays, useWorkspaceOverlays } from "./hooks/useWorkspaceOverlays";
import { isWorkspacePreviewPath } from "./lib/workspacePreviewKind";
import type { ArchivedSessionSummary, Project, SessionSummary } from "./types/contracts";

export function App() {
  const {
    appInfo,
    sessions,
    activePath,
    runtimeStates,
    loading,
    error,
    setError,
    setActivePath,
    refreshSessions,
    refreshAppInfo,
    activate,
  } = useSessionRuntime();
  /** Background runs that finished unseen: sidebar dots + the dock badge. */
  const unseenRuns = useUnseenRunCompletions(runtimeStates, activePath);
  // Mirror the unseen dots onto the macOS dock badge (1 dot → “1”, …).
  useEffect(() => {
    void window.ePi.app.setDockBadge(unseenRuns.size);
  }, [unseenRuns]);
  const [packageOpen, setPackageOpen] = useState(false);
  const [skillOpen, setSkillOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<SessionSummary>();
  const [renameName, setRenameName] = useState("");
  const [removeTarget, setRemoveTarget] = useState<SessionSummary>();
  /**
   * Session created by this window session; its terminal gets focus so interactive prompts (e.g. project trust) are
   * immediately answerable.
   */
  const [justCreatedPath, setJustCreatedPath] = useState<string>();
  /** Sessions whose terminal painted at least one frame; hides the "loading session" overlay. */
  const [paintedPaths, setPaintedPaths] = useState<Set<string>>(new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Sessions moved to the archived-sessions area (Settings → Archived). */
  const [archivedSessions, setArchivedSessions] = useState<ArchivedSessionSummary[]>([]);
  const [panelOpen, setPanelOpen] = useState(true);
  /** Multi-folder projects; drives the sidebar grouping and repo switcher. */
  const [projects, setProjects] = useState<Project[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  /** Project currently being edited in the import dialog. */
  const [editingProject, setEditingProject] = useState<Project>();
  /** Folder group being promoted to a multi-repo project (import dialog pre-fill). */
  const [promoteCwd, setPromoteCwd] = useState<string>();
  /** Stable pre-fill for the import dialog; identity must not change while open. */
  const promoteInitial = useMemo(
    () => (promoteCwd ? { folders: [promoteCwd], primaryRepo: promoteCwd } : undefined),
    [promoteCwd],
  );
  /** Project group pending removal (multi-folder or implicit); its sessions go to the Trash. */
  const [removeProjectTarget, setRemoveProjectTarget] = useState<{
    project?: Project;
    cwd: string;
    sessions: SessionSummary[];
    /** Called after a confirmed removal, so callers can forget UI-only state. */
    onConfirmed?: () => void;
  }>();
  /** Open tool-panel tabs plus the active one; review is a singleton. */
  const [panel, setPanel] = useState<PanelState>({ tabs: [], activeId: undefined });
  const overlays = useWorkspaceOverlays();

  const handleAppInfoChange = useCallback(async () => {
    const previousMode = appInfo?.tuiOptimizationsEnabled !== false;
    const nextInfo = await refreshAppInfo();
    const nextMode = nextInfo?.tuiOptimizationsEnabled !== false;
    if (nextInfo && previousMode !== nextMode) {
      // A fullscreen transcript and a stock main-screen transcript are not
      // replay-compatible. Discard every cached frame after all processes have
      // restarted, then let the newly mounted terminal receive a fresh frame.
      clearAllTerminalBuffers();
      setPaintedPaths(new Set());
      setTerminalEpoch((current) => current + 1);
    }
  }, [appInfo, refreshAppInfo]);

  // Dev hot-reload restores the open editor/preview overlays.
  useEffect(() => {
    restoreWorkspaceOverlays(overlays);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeSession = useMemo(() => sessions.find((session) => session.path === activePath), [activePath, sessions]);
  const runtimeState = activePath ? runtimeStates[activePath] : undefined;
  const activeCwd = activeSession?.cwd || appInfo?.defaultCwd || "";
  /** The project owning the active session's cwd (multi-repo routing). */
  const activeProject = useMemo(
    () => projects.find((project) => project.folders.includes(activeCwd)),
    [projects, activeCwd],
  );
  /** Git repos of the active project, for the review repo switcher. */
  const [activeProjectRepos, setActiveProjectRepos] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!activeProject) {
      setActiveProjectRepos([]);
      return;
    }
    void window.ePi.projects
      .gitRepos(activeProject.folders)
      .then((repos) => {
        if (!cancelled) setActiveProjectRepos(repos);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeProject]);
  /**
   * Hide the loading overlay ~80ms after the terminal's first paint instead
   * of instantly: the TUI's initial frame is written, then its layout
   * (reflow + viewport sync) settles over the next few frames — revealing
   * the terminal mid-settle flashes the layout as it finishes.
   */
  const FIRST_PAINT_HIDE_DELAY_MS = 80;
  const handleFirstPaint = useCallback((sessionKey: string) => {
    window.setTimeout(() => {
      setPaintedPaths((current) => (current.has(sessionKey) ? current : new Set(current).add(sessionKey)));
    }, FIRST_PAINT_HIDE_DELAY_MS);
  }, []);
  // The TUI has not mounted yet (pi still booting, or the session was never
  // started in this app run); a failed session shows the error bar instead.
  const showTerminalLoading =
    !loading &&
    !!activePath &&
    !paintedPaths.has(activePath) &&
    runtimeState?.status !== "exited" &&
    runtimeState?.status !== "error";

  const createSession = useCallback(
    async (cwd?: string): Promise<SessionSummary | undefined> => {
      setError(undefined);
      const targetCwd = cwd?.trim() || appInfo?.defaultCwd;
      try {
        const session = await window.ePi.sessions.create({ cwd: targetCwd });
        window.ePi.app.log(`[app] createSession created=${session.path} cwd=${session.cwd}`);
        setActivePath(session.path);
        setJustCreatedPath(session.path);
        // Re-sort from the source of truth instead of blind-prepending: background
        // agent activity can change other sessions' recency since the last list,
        // and a stale prepend would leave the sidebar in the wrong order until the
        // next refresh (visible as a second jump).
        await refreshSessions();
        await activate(session.path);
        return session;
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(message);
        toast.error(`Failed to create session: ${message}`);
        return undefined;
      }
    },
    [appInfo, refreshSessions, activate, setActivePath, setError, setJustCreatedPath],
  );

  /** "Import multi-repo project": persist the project, then start a session in its primary repo. */
  const handleImportProject = useCallback(
    async (request: { name?: string; folders: string[]; primaryRepo: string }): Promise<void> => {
      setError(undefined);
      try {
        const next = await window.ePi.projects.create(request);
        setProjects(next);
        window.ePi.app.log(`[app] import project folders=${request.folders.length} primary=${request.primaryRepo}`);
        await createSession(request.primaryRepo);
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(message);
        throw reason;
      }
    },
    [createSession, setError, setProjects],
  );

  /** Persist edits to an existing project. */
  const handleUpdateProject = useCallback(
    async (id: string, request: { name?: string; folders: string[]; primaryRepo: string }): Promise<void> => {
      setError(undefined);
      try {
        const next = await window.ePi.projects.update({ id, ...request });
        setProjects(next);
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(message);
        throw reason;
      }
    },
    [setError, setProjects],
  );

  const openEditProject = useCallback((project: Project) => {
    setPromoteCwd(undefined);
    setEditingProject(project);
    setImportOpen(true);
  }, []);

  /** Non-multi-repo folder group: pre-fill the import dialog to promote it to a multi-repo project. */
  const openPromoteProject = useCallback((cwd: string) => {
    setEditingProject(undefined);
    setPromoteCwd(cwd);
    setImportOpen(true);
  }, []);

  /** Create the project record only (no new session) when promoting a folder group. */
  const handlePromoteProject = useCallback(
    async (request: { name?: string; folders: string[]; primaryRepo: string }): Promise<void> => {
      setError(undefined);
      try {
        const next = await window.ePi.projects.create(request);
        setProjects(next);
        window.ePi.app.log(`[app] promote project folders=${request.folders.length} primary=${request.primaryRepo}`);
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(message);
        throw reason;
      }
    },
    [setError, setProjects],
  );

  const removeProject = useCallback(
    (target: { project?: Project; cwd: string; sessions: SessionSummary[] }, onConfirmed?: () => void) => {
      setRemoveProjectTarget({ ...target, onConfirmed });
    },
    [],
  );

  /** Archive the project's sessions, then drop the project record (multi-folder only). */
  const confirmRemoveProject = async () => {
    if (!removeProjectTarget) return;
    try {
      const { project, sessions: projectSessions, onConfirmed } = removeProjectTarget;
      // Archive each session file; different sessions share no state, so they
      // can be archived in parallel. Archiving (not trashing) keeps the
      // project recoverable from Settings → Archived.
      await Promise.all(projectSessions.map((session) => window.ePi.sessions.archive(session.path)));
      if (project) {
        setProjects(await window.ePi.projects.remove(project.id));
      }
      await refreshSessions();
      await refreshArchivedSessions();
      if (activePath && projectSessions.some((session) => session.path === activePath)) setActivePath(undefined);
      setRemoveProjectTarget(undefined);
      onConfirmed?.();
      toast.success("Project removed");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      toast.error(`Failed to remove project: ${message}`);
    }
  };

  const selectSession = useCallback(
    (session: SessionSummary) => {
      setError(undefined);
      window.ePi.app.log(`[app] selectSession ${session.path}`);
      setActivePath(session.path);
      void activate(session.path);
    },
    [activate, setActivePath, setError],
  );

  // Clicking a task-completion banner opens that session in the UI.
  useEffect(() => {
    return window.ePi.notifications.onOpenSession((sessionPath) => {
      const session = sessions.find((candidate) => candidate.path === sessionPath);
      if (!session) return;
      selectSession(session);
    });
  });

  const renameSession = useCallback(async (session: SessionSummary) => {
    setRenameTarget(session);
    setRenameName(session.name || session.firstMessage);
  }, []);

  const commitRename = async () => {
    if (!renameTarget || !renameName.trim()) return;
    try {
      await window.ePi.sessions.rename({ path: renameTarget.path, name: renameName.trim() });
      await refreshSessions();
      setRenameTarget(undefined);
      toast.success("Session renamed");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      toast.error(`Failed to rename session: ${message}`);
    }
  };

  const removeSession = useCallback((session: SessionSummary) => {
    setRemoveTarget(session);
  }, []);

  /** Refresh the archived-sessions list from the main process. */
  const refreshArchivedSessions = useCallback(async (): Promise<void> => {
    try {
      setArchivedSessions(await window.ePi.sessions.listArchived());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [setError]);

  // The archived list only matters while Settings is open; load it fresh
  // every time so archive/unarchive/delete elsewhere stays reflected.
  useEffect(() => {
    if (!settingsOpen) return;
    void window.ePi.sessions
      .listArchived()
      .then(setArchivedSessions)
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [settingsOpen, setError]);

  const confirmRemoveSession = async () => {
    if (!removeTarget) return;
    try {
      await window.ePi.sessions.archive(removeTarget.path);
      await refreshSessions();
      await refreshArchivedSessions();
      if (activePath === removeTarget.path) setActivePath(undefined);
      setRemoveTarget(undefined);
      toast.success("Session archived");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      toast.error(`Failed to archive session: ${message}`);
    }
  };

  /** Restore an archived session; it reappears in its original project. */
  const unarchiveSession = async (session: ArchivedSessionSummary) => {
    try {
      await window.ePi.sessions.unarchive(session.path);
      await refreshSessions();
      await refreshArchivedSessions();
      toast.success("Session restored");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      toast.error(`Failed to restore session: ${message}`);
    }
  };

  /** Permanently delete an archived session (system Trash as the last stop). */
  const deleteArchivedSession = async (session: ArchivedSessionSummary) => {
    try {
      await window.ePi.sessions.deleteArchived(session.path);
      await refreshArchivedSessions();
      toast.success("Session deleted");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      toast.error(`Failed to delete session: ${message}`);
    }
  };

  const submit = useCallback(
    async (messages: string[]): Promise<boolean> => {
      setError(undefined);
      const sessionPath = activePath || (await createSession())?.path;
      if (!sessionPath) return false;
      try {
        await messages.reduce(
          (previous, message) =>
            previous.then(() => {
              window.ePi.app.log(`[app] submit session=${sessionPath} text=${message.slice(0, 60)}`);
              return window.ePi.runtime.submit(sessionPath, message);
            }),
          Promise.resolve(),
        );
        return true;
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
        return false;
      }
    },
    [activePath, createSession, setError],
  );

  const openPanelTab = useCallback((view: PanelView, forceNew = false) => {
    setPanel((current) => {
      if (!forceNew) {
        const existing = current.tabs.find((tab) => tab.view === view);
        if (existing) return { ...current, activeId: existing.id };
      }
      // Review is a singleton: never duplicate it even on forceNew.
      if (view === "review") {
        const review = current.tabs.find((tab) => tab.view === "review");
        if (review) return { ...current, activeId: review.id };
      }
      const tab: PanelTab = { id: crypto.randomUUID(), view };
      return { tabs: [...current.tabs, tab], activeId: tab.id };
    });
  }, []);

  const closePanelTab = useCallback((id: string) => {
    setPanel((current) => {
      const index = current.tabs.findIndex((tab) => tab.id === id);
      if (index < 0) return current;
      const tabs = current.tabs.filter((tab) => tab.id !== id);
      // Activate the right neighbour, else the left one; none left shows the launch pad.
      const activeId = current.activeId === id ? (tabs[index] ?? tabs[index - 1])?.id : current.activeId;
      return { tabs, activeId };
    });
  }, []);

  const selectPanelTab = useCallback((id: string) => {
    setPanel((current) => (current.tabs.some((tab) => tab.id === id) ? { ...current, activeId: id } : current));
  }, []);

  /** The project folder containing a workspace path (multi-repo sibling support). */
  const folderContainingPath = useCallback(
    (path: string): string | undefined => {
      if (!activeProject) return undefined;
      const normalized = path.replace(/\\/g, "/");
      return activeProject.folders.find((folder) => normalized.startsWith(`${folder.replace(/\\/g, "/")}/`));
    },
    [activeProject],
  );

  /** Open a workspace file through the preview/editor routing. */
  const { openFilePreview: overlaysOpenFilePreview, openEditorFile: overlaysOpenEditorFile } = overlays;
  const handleOpenWorkspaceFile = useCallback(
    (path: string, imagePaths?: string[]) => {
      // The file tree can browse every repo of a multi-repo project, so the
      // read must be rooted at the folder containing the file — not the
      // active session's cwd (which would trip the workspace confinement).
      const cwd = folderContainingPath(path) ?? activeCwd;
      if (!cwd) return;
      if (isWorkspacePreviewPath(path)) {
        overlaysOpenFilePreview({ cwd, path, imagePaths });
      } else {
        overlaysOpenEditorFile({ cwd, path });
      }
    },
    [activeCwd, folderContainingPath, overlaysOpenEditorFile, overlaysOpenFilePreview],
  );

  /** Open a workspace path from inside previews (markdown links, images). */
  const handleOpenWorkspacePath = useCallback(
    (absPath: string) => {
      handleOpenWorkspaceFile(absPath);
    },
    [handleOpenWorkspaceFile],
  );

  /** Open a workspace file link from the terminal (OSC 8), at a line. */
  const handleOpenFileLink = useCallback(
    (absPath: string, line?: number) => {
      if (!activeCwd) {
        void window.ePi.app.openPath(absPath);
        return;
      }
      if (absPath.startsWith(activeCwd)) {
        if (isWorkspacePreviewPath(absPath)) {
          overlaysOpenFilePreview({ cwd: activeCwd, path: absPath });
        } else {
          overlaysOpenEditorFile({ cwd: activeCwd, path: absPath, line });
        }
        return;
      }
      void window.ePi.app.openPath(absPath);
    },
    [activeCwd, overlaysOpenEditorFile, overlaysOpenFilePreview],
  );

  // Workspace fs watching follows the active session cwd.
  useEffect(() => {
    if (!activeCwd) return;
    void window.ePi.workspace.watchStart(activeCwd).catch(() => undefined);
    return () => {
      void window.ePi.workspace.watchStop(activeCwd).catch(() => undefined);
    };
  }, [activeCwd]);

  // Session switch: close the overlays (dirty editor tabs ask for confirmation).
  useEffect(() => {
    overlays.requestEditorClose();
    overlays.requestPreviewClose();
  }, [activeCwd]); // eslint-disable-line react-hooks/exhaustive-deps

  // Native fullscreen (macOS): the menu bar hides and the traffic lights
  // move up into the menu-bar row. Mirror the state on <body> so the CSS can
  // adjust the brand row (see app-shell.css).
  useEffect(() => {
    return window.ePi.app.onFullscreenChange((isFullscreen) => {
      if (isFullscreen) document.body.dataset.fullscreen = "";
      else delete document.body.dataset.fullscreen;
    });
  }, []);

  useGlobalShortcuts({
    defaultCwd: appInfo?.defaultCwd,
    packageOpen,
    skillOpen,
    onNewSession: (cwd) => void createSession(cwd),
    onClosePackages: () => setPackageOpen(false),
    onCloseSkills: () => setSkillOpen(false),
    onTogglePanel: () => setPanelOpen((current) => !current),
    onOpenPanelTab: (view) => {
      setPanelOpen(true);
      openPanelTab(view);
    },
  });

  const openPackages = useCallback(() => {
    if (!activeCwd) return;
    setPackageOpen(true);
  }, [activeCwd]);

  const openSkills = useCallback(() => {
    if (!activeCwd) return;
    setSkillOpen(true);
  }, [activeCwd]);

  /**
   * Bumped on every manual session reload. Forces the TerminalPanel to
   * remount (new xterm instance), which re-fits the grid and re-sends the
   * real pty size — the same code path as entering a session, so the TUI
   * lays out correctly right after a reload instead of keeping the stale
   * 120x36 pty grid.
   */
  const [terminalEpoch, setTerminalEpoch] = useState(0);

  /** Restart one session's pi process; used to load packages installed while it ran. */
  const reloadSessionPath = useCallback(
    async (sessionPath: string): Promise<void> => {
      setError(undefined);
      await window.ePi.runtime.stop(sessionPath);
      clearTerminalBuffer(sessionPath);
      // The remounted terminal is blank until the fresh pi process paints its
      // first frame; forget the old paint so the loading overlay shows again.
      setPaintedPaths((current) => {
        if (!current.has(sessionPath)) return current;
        const next = new Set(current);
        next.delete(sessionPath);
        return next;
      });
      await activate(sessionPath);
      setTerminalEpoch((current) => current + 1);
    },
    [activate, setError, setPaintedPaths, setTerminalEpoch],
  );

  const reloadPi = useCallback(async () => {
    if (!activePath) return;
    try {
      await reloadSessionPath(activePath);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [activePath, reloadSessionPath, setError]);

  /** Sidebar "Reload session": restart that session's process without switching to it. */
  const reloadSession = useCallback(
    async (session: SessionSummary) => {
      try {
        await reloadSessionPath(session.path);
        toast.success("Session reloaded");
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(message);
        toast.error(`Failed to reload session: ${message}`);
      }
    },
    [reloadSessionPath, setError],
  );

  // Keep a stable reload callback for the memoized panels: App re-renders on
  // every runtime-state update, and a fresh `reloadPi` reference would defeat
  // PackagePanel/SkillPanel memoization, re-rendering their Tabs/Select trees.
  const reloadPiRef = useRef(reloadPi);
  reloadPiRef.current = reloadPi;
  const onReloadPi = useCallback(() => reloadPiRef.current(), []);

  // Stable callbacks for the memoized children: App re-renders on every
  // runtime-state update, and inline arrows would defeat their memoization.
  const togglePanel = useCallback(() => setPanelOpen((current) => !current), []);
  const openImportProject = useCallback(() => {
    setEditingProject(undefined);
    setImportOpen(true);
  }, []);
  const openFolder = useCallback((cwd: string) => void window.ePi.app.openPath(cwd), []);
  const copyText = useCallback((text: string) => void window.ePi.app.copyText(text), []);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const interrupt = useCallback(() => {
    if (activePath) void window.ePi.runtime.interrupt(activePath);
  }, [activePath]);

  // Drawers and dialogs are portaled to <body> at z-50, so they cover the
  // topbar — but Electron's window-drag mask ignores z-index and would still
  // swallow clicks on their top area. Disable the topbar drag region while
  // any modal layer is open.
  const modalOpen =
    packageOpen ||
    skillOpen ||
    settingsOpen ||
    importOpen ||
    renameTarget !== undefined ||
    removeTarget !== undefined ||
    removeProjectTarget !== undefined;

  // Load multi-folder projects and keep them in sync with the main process.
  useEffect(() => {
    void window.ePi.projects
      .list()
      .then(setProjects)
      .catch(() => undefined);
    return window.ePi.projects.onUpdated(setProjects);
  }, []);

  return (
    <div className="app-shell" data-modal-open={modalOpen ? "" : undefined}>
      <SidebarProvider className="app-content">
        <AppHeader activeSession={activeSession} panelOpen={panelOpen} onTogglePanel={togglePanel} />

        <SessionSidebar
          sessions={sessions}
          projects={projects}
          activePath={activePath}
          runtimeStates={runtimeStates}
          homeCwd={appInfo?.defaultCwd}
          platform={appInfo?.platform}
          onSelect={selectSession}
          onCreate={createSession}
          onImportProject={openImportProject}
          onEditProject={openEditProject}
          onPromoteProject={openPromoteProject}
          onRemoveProject={removeProject}
          onRename={renameSession}
          onRemove={removeSession}
          onReload={reloadSession}
          onOpenFolder={openFolder}
          onCopyText={copyText}
          onOpenPackages={openPackages}
          onOpenSkills={openSkills}
          onOpenSettings={openSettings}
        />

        <div className="app-main">
          <SidebarInset
            className="workspace"
            data-tui-optimizations={appInfo?.tuiOptimizationsEnabled !== false ? "true" : "false"}
          >
            {" "}
            <div className="terminal-frame">
              {loading ? (
                <div className="workspace-empty">
                  <div className="skeleton-line wide" />
                  <div className="skeleton-line" />
                </div>
              ) : activeSession ? (
                <TerminalPanel
                  key={`${activeSession.path}:${terminalEpoch}:${appInfo?.tuiOptimizationsEnabled === false ? "stock" : "optimized"}`}
                  sessionKey={activeSession.path}
                  tuiOptimizationsEnabled={appInfo?.tuiOptimizationsEnabled !== false}
                  autoFocus={activePath === justCreatedPath && runtimeState?.status === "starting"}
                  onFirstPaint={handleFirstPaint}
                  onOpenFileLink={handleOpenFileLink}
                />
              ) : (
                <div className="workspace-empty">
                  <div className="empty-terminal-icon">
                    <Terminal size={20} />
                  </div>
                  <h3>New session</h3>
                  <p>{appInfo?.defaultCwd}</p>
                </div>
              )}
              {showTerminalLoading ? (
                <div className="terminal-loading" role="status" aria-label="Loading session">
                  <span className="terminal-loading-spinner" />
                  <span className="terminal-loading-label">Loading session…</span>
                </div>
              ) : null}
            </div>
            {error ? (
              <div className="runtime-error" role="alert">
                <X size={14} />
                <span>{error}</span>
                <IconButton label="Dismiss error" onClick={() => setError(undefined)}>
                  <X size={14} />
                </IconButton>
              </div>
            ) : null}
            <Composer
              sessionPath={activePath}
              status={runtimeState?.status}
              activity={runtimeState?.activity}
              model={runtimeState?.model}
              thinkingLevel={runtimeState?.thinkingLevel}
              supportedThinkingLevels={runtimeState?.supportedThinkingLevels}
              context={runtimeState?.context}
              usage={runtimeState?.usage}
              cacheHitRate={runtimeState?.cacheHitRate}
              speed={runtimeState?.speed}
              cwd={activeCwd}
              focusRequest={activePath !== undefined && runtimeState?.status === "running" ? activePath : undefined}
              disabled={
                loading ||
                runtimeState?.status === "starting" ||
                runtimeState?.status === "stopping" ||
                runtimeState?.status === "error" ||
                runtimeState?.status === "exited"
              }
              onSubmit={submit}
              onInterrupt={interrupt}
            />
            <WorkspaceOverlayHost overlays={overlays} cwd={activeCwd} onOpenWorkspacePath={handleOpenWorkspacePath} />
          </SidebarInset>
        </div>

        <SidebarProvider
          side="right"
          storageKey="tool-panel-width-v2"
          open={panelOpen}
          onOpenChange={setPanelOpen}
          className="tool-panel-layout"
        >
          <Sidebar side="right" collapsible="offcanvas" className="tool-panel-sidebar">
            <ToolPanel
              cwd={activeCwd}
              repos={activeProjectRepos}
              primaryRepo={activeProject?.primaryRepo}
              tabs={panel.tabs}
              activeTabId={panel.activeId}
              platform={appInfo?.platform}
              onOpenTab={openPanelTab}
              onCloseTab={closePanelTab}
              onSelectTab={selectPanelTab}
              onOpenFile={handleOpenWorkspaceFile}
            />
          </Sidebar>
          <SidebarRail />
        </SidebarProvider>
      </SidebarProvider>

      <AppDialogs
        renameTarget={renameTarget}
        renameName={renameName}
        onRenameNameChange={setRenameName}
        onCommitRename={() => void commitRename()}
        onCloseRename={() => setRenameTarget(undefined)}
        removeTarget={removeTarget}
        onConfirmRemove={() => void confirmRemoveSession()}
        onCloseRemove={() => setRemoveTarget(undefined)}
        removeProjectTarget={removeProjectTarget}
        onConfirmRemoveProject={() => void confirmRemoveProject()}
        onCloseRemoveProject={() => setRemoveProjectTarget(undefined)}
        archivedSessions={archivedSessions}
        onUnarchiveArchived={(session) => void unarchiveSession(session)}
        onDeleteArchived={(session) => void deleteArchivedSession(session)}
        settingsOpen={settingsOpen}
        onSettingsOpenChange={setSettingsOpen}
        appInfo={appInfo}
        onAppInfoChange={() => void handleAppInfoChange()}
      />

      <PackagePanel open={packageOpen} cwd={activeCwd} onOpenChange={setPackageOpen} onReloadPi={onReloadPi} />
      <SkillPanel open={skillOpen} cwd={activeCwd} onOpenChange={setSkillOpen} onReloadPi={onReloadPi} />
      <ImportMultiRepoDialog
        open={importOpen}
        defaultPath={appInfo?.defaultCwd}
        editing={editingProject}
        // Stable object so the dialog draft is only reset on open, not every render.
        initial={promoteInitial}
        onOpenChange={(open) => {
          setImportOpen(open);
          if (!open) {
            setEditingProject(undefined);
            setPromoteCwd(undefined);
          }
        }}
        onCreateProject={promoteCwd ? handlePromoteProject : handleImportProject}
        onUpdateProject={handleUpdateProject}
      />
    </div>
  );
}
