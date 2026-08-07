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
import { clearTerminalBuffer, TerminalPanel } from "@/components/workspace/TerminalPanel";
import { ToolPanel } from "@/components/workspace/ToolPanel";
import type { PanelState, PanelTab, PanelView } from "@/components/workspace/ToolPanel";

import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { useSessionRuntime } from "./hooks/useSessionRuntime";
import type { Project, SessionSummary } from "./types/contracts";

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
  const [panelOpen, setPanelOpen] = useState(true);
  /** Multi-folder projects; drives the sidebar grouping and repo switcher. */
  const [projects, setProjects] = useState<Project[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  /** Project currently being edited in the import dialog. */
  const [editingProject, setEditingProject] = useState<Project>();
  /** Open tool-panel tabs plus the active one; review is a singleton. */
  const [panel, setPanel] = useState<PanelState>({ tabs: [], activeId: undefined });

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
  const handleFirstPaint = useCallback((sessionKey: string) => {
    setPaintedPaths((current) => (current.has(sessionKey) ? current : new Set(current).add(sessionKey)));
  }, []);
  // The TUI has not mounted yet (pi still booting, or the session was never
  // started in this app run); a failed session shows the error bar instead.
  const showTerminalLoading =
    !loading &&
    !!activePath &&
    !paintedPaths.has(activePath) &&
    runtimeState?.status !== "exited" &&
    runtimeState?.status !== "error";

  const createSession = async (cwd?: string): Promise<SessionSummary | undefined> => {
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
  };

  /** New project: ask the user for a folder, then start a session inside it. */
  const createProjectSession = async (): Promise<void> => {
    setError(undefined);
    const cwd = await window.ePi.app.chooseDirectory(appInfo?.defaultCwd);
    if (!cwd) return;
    await createSession(cwd);
  };

  /** "Import multi-repo project": persist the project, then start a session in its primary repo. */
  const handleImportProject = async (request: {
    name?: string;
    folders: string[];
    primaryRepo: string;
  }): Promise<void> => {
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
  };

  /** Persist edits to an existing project. */
  const handleUpdateProject = async (
    id: string,
    request: { name?: string; folders: string[]; primaryRepo: string },
  ): Promise<void> => {
    setError(undefined);
    try {
      const next = await window.ePi.projects.update({ id, ...request });
      setProjects(next);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      throw reason;
    }
  };

  const openEditProject = (project: Project) => {
    setEditingProject(project);
    setImportOpen(true);
  };

  const selectSession = (session: SessionSummary) => {
    setError(undefined);
    window.ePi.app.log(`[app] selectSession ${session.path}`);
    setActivePath(session.path);
    void activate(session.path);
  };

  // Clicking a task-completion banner opens that session in the UI.
  useEffect(() => {
    return window.ePi.notifications.onOpenSession((sessionPath) => {
      const session = sessions.find((candidate) => candidate.path === sessionPath);
      if (!session) return;
      selectSession(session);
    });
  });

  const renameSession = async (session: SessionSummary) => {
    setRenameTarget(session);
    setRenameName(session.name || session.firstMessage);
  };

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

  const removeSession = (session: SessionSummary) => {
    setRemoveTarget(session);
  };

  const confirmRemoveSession = async () => {
    if (!removeTarget) return;
    try {
      await window.ePi.sessions.remove(removeTarget.path);
      await refreshSessions();
      if (activePath === removeTarget.path) setActivePath(undefined);
      setRemoveTarget(undefined);
      toast.success("Session deleted");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      toast.error(`Failed to delete session: ${message}`);
    }
  };

  const submit = async (messages: string[]): Promise<boolean> => {
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
  };

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

  const openPackages = () => {
    if (!activeCwd) return;
    setPackageOpen(true);
  };

  const openSkills = () => {
    if (!activeCwd) return;
    setSkillOpen(true);
  };

  const reloadPi = async () => {
    if (!activePath) return;
    setError(undefined);
    try {
      await window.ePi.runtime.stop(activePath);
      clearTerminalBuffer(activePath);
      await activate(activePath);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  // Keep a stable reload callback for the memoized panels: App re-renders on
  // every runtime-state update, and a fresh `reloadPi` reference would defeat
  // PackagePanel/SkillPanel memoization, re-rendering their Tabs/Select trees.
  const reloadPiRef = useRef(reloadPi);
  reloadPiRef.current = reloadPi;
  const onReloadPi = useCallback(() => reloadPiRef.current(), []);

  // Drawers and dialogs are portaled to <body> at z-50, so they cover the
  // topbar — but Electron's window-drag mask ignores z-index and would still
  // swallow clicks on their top area. Disable the topbar drag region while
  // any modal layer is open.
  const modalOpen =
    packageOpen || skillOpen || settingsOpen || importOpen || renameTarget !== undefined || removeTarget !== undefined;

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
        <AppHeader
          activeSession={activeSession}
          panelOpen={panelOpen}
          onTogglePanel={() => setPanelOpen((current) => !current)}
        />

        <SessionSidebar
          sessions={sessions}
          projects={projects}
          activePath={activePath}
          runtimeStates={runtimeStates}
          homeCwd={appInfo?.defaultCwd}
          platform={appInfo?.platform}
          onSelect={selectSession}
          onCreate={createSession}
          onCreateProject={() => void createProjectSession()}
          onImportProject={() => {
            setEditingProject(undefined);
            setImportOpen(true);
          }}
          onEditProject={openEditProject}
          onRename={(session) => void renameSession(session)}
          onRemove={(session) => void removeSession(session)}
          onOpenFolder={(cwd) => void window.ePi.app.openPath(cwd)}
          onCopyText={(text) => void window.ePi.app.copyText(text)}
          onOpenPackages={openPackages}
          onOpenSkills={openSkills}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <div className="app-main">
          <SidebarInset className="workspace">
            {" "}
            <div className="terminal-frame">
              {loading ? (
                <div className="workspace-empty">
                  <div className="skeleton-line wide" />
                  <div className="skeleton-line" />
                </div>
              ) : activeSession ? (
                <TerminalPanel
                  sessionKey={activeSession.path}
                  autoFocus={activePath === justCreatedPath && runtimeState?.status === "starting"}
                  onFirstPaint={handleFirstPaint}
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
              onInterrupt={() => activePath && window.ePi.runtime.interrupt(activePath)}
            />
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
        settingsOpen={settingsOpen}
        onSettingsOpenChange={setSettingsOpen}
        appInfo={appInfo}
        onAppInfoChange={() => void refreshAppInfo()}
      />

      <PackagePanel open={packageOpen} cwd={activeCwd} onOpenChange={setPackageOpen} onReloadPi={onReloadPi} />
      <SkillPanel open={skillOpen} cwd={activeCwd} onOpenChange={setSkillOpen} onReloadPi={onReloadPi} />
      <ImportMultiRepoDialog
        open={importOpen}
        defaultPath={appInfo?.defaultCwd}
        editing={editingProject}
        onOpenChange={(open) => {
          setImportOpen(open);
          if (!open) setEditingProject(undefined);
        }}
        onCreateProject={handleImportProject}
        onUpdateProject={handleUpdateProject}
      />
    </div>
  );
}
