import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal, X } from "lucide-react";
import { AppDialogs } from "./components/AppDialogs";
import { AppHeader } from "./components/AppHeader";
import { Composer } from "./components/Composer";
import { IconButton } from "./components/IconButton";
import { PackagePanel } from "./components/PackagePanel";
import { SessionSidebar } from "./components/SessionSidebar";
import { SkillPanel } from "./components/SkillPanel";
import { clearTerminalBuffer, TerminalPanel } from "./components/TerminalPanel";
import type { AppInfo, PiRuntimeState, SessionSummary } from "./types/contracts";
import { SidebarInset, SidebarProvider } from "./components/ui/sidebar";

export function App() {
  const [appInfo, setAppInfo] = useState<AppInfo>();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activePath, setActivePath] = useState<string>();
  /** Per-session process states; sessions run concurrently and never stop each other. */
  const [runtimeStates, setRuntimeStates] = useState<Record<string, PiRuntimeState>>({});
  const [packageOpen, setPackageOpen] = useState(false);
  const [skillOpen, setSkillOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [renameTarget, setRenameTarget] = useState<SessionSummary>();
  const [renameName, setRenameName] = useState("");
  const [removeTarget, setRemoveTarget] = useState<SessionSummary>();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const activeSession = useMemo(
    () => sessions.find((session) => session.path === activePath),
    [activePath, sessions],
  );
  const runtimeState = activePath ? runtimeStates[activePath] : undefined;
  const activeCwd = activeSession?.cwd || appInfo?.defaultCwd || "";

  /** Bring a session to the front and ensure its pi process is running. */
  const activate = async (path: string): Promise<void> => {
    setError(undefined);
    const target = runtimeStates[path];
    const needsFreshStart =
      !target ||
      target.status === "idle" ||
      target.status === "exited" ||
      target.status === "error";
    if (needsFreshStart) clearTerminalBuffer(path);
    await window.ePi.runtime.start(path);
  };

  const refreshSessions = async () => {
    try {
      const next = await window.ePi.sessions.list();
      setSessions(next);
      setActivePath((current) =>
        current && next.some((session) => session.path === current) ? current : next[0]?.path,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => {
    let active = true;
    Promise.all([
      window.ePi.app.getInfo(),
      window.ePi.sessions.list(),
      window.ePi.runtime.getStates(),
    ])
      .then(([info, nextSessions, states]) => {
        if (!active) return;
        setAppInfo(info);
        setSessions(nextSessions);
        setRuntimeStates(states);
        const initial = nextSessions[0]?.path;
        setActivePath(initial);
        setLoading(false);
        window.ePi.app.log(
          `[app] init sessions=${nextSessions.length} states=${Object.keys(states).length}`,
        );
        if (initial) {
          void window.ePi.runtime.start(initial).catch((reason: unknown) => {
            setError(reason instanceof Error ? reason.message : String(reason));
          });
        }
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setLoading(false);
      });
    const stopState = window.ePi.runtime.onState((state) => {
      window.ePi.app.log(
        `[app] onState ${JSON.stringify({ status: state.status, sessionPath: state.sessionPath })}`,
      );
      setRuntimeStates((current) => ({ ...current, [state.sessionPath]: state }));
    });
    return () => {
      active = false;
      stopState();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        void createSession(appInfo?.defaultCwd);
      }
      if (event.key === "Escape" && packageOpen) setPackageOpen(false);
      if (event.key === "Escape" && skillOpen) setSkillOpen(false);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  });

  const createSession = async (cwd?: string): Promise<SessionSummary | undefined> => {
    setError(undefined);
    const targetCwd = cwd?.trim() || appInfo?.defaultCwd;
    try {
      const session = await window.ePi.sessions.create({ cwd: targetCwd });
      window.ePi.app.log(`[app] createSession created=${session.path} cwd=${session.cwd}`);
      setSessions((current) => [session, ...current]);
      setActivePath(session.path);
      await activate(session.path);
      return session;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    }
  };

  const selectSession = (session: SessionSummary) => {
    setError(undefined);
    window.ePi.app.log(`[app] selectSession ${session.path}`);
    setActivePath(session.path);
    void activate(session.path);
  };

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
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
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
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
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

  return (
    <div className="app-shell">
      <SidebarProvider className="app-content">
        <AppHeader activeSession={activeSession} />

        <div className="app-main">
          <SessionSidebar
            sessions={sessions}
            activePath={activePath}
            runtimeStates={runtimeStates}
            homeCwd={appInfo?.defaultCwd}
            platform={appInfo?.platform}
            onSelect={selectSession}
            onCreate={createSession}
            onRename={(session) => void renameSession(session)}
            onRemove={(session) => void removeSession(session)}
            onOpenFolder={(cwd) => void window.ePi.app.openPath(cwd)}
            onCopyText={(text) => void window.ePi.app.copyText(text)}
            onOpenPackages={openPackages}
            onOpenSkills={openSkills}
            onOpenSettings={() => setSettingsOpen(true)}
          />

          <SidebarInset className="workspace">
            <div className="terminal-frame">
              {loading ? (
                <div className="workspace-empty">
                  <div className="skeleton-line wide" />
                  <div className="skeleton-line" />
                </div>
              ) : activeSession ? (
                <TerminalPanel sessionKey={activeSession.path} />
              ) : (
                <div className="workspace-empty">
                  <div className="empty-terminal-icon">
                    <Terminal size={20} />
                  </div>
                  <h3>New session</h3>
                  <p>{appInfo?.defaultCwd}</p>
                </div>
              )}
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
              status={runtimeState?.status ?? "idle"}
              activity={runtimeState?.activity}
              model={runtimeState?.model}
              context={runtimeState?.context}
              usage={runtimeState?.usage}
              cacheHitRate={runtimeState?.cacheHitRate}
              cwd={activeCwd}
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
      />

      <PackagePanel
        open={packageOpen}
        cwd={activeCwd}
        onOpenChange={setPackageOpen}
        onReloadPi={onReloadPi}
      />
      <SkillPanel
        open={skillOpen}
        cwd={activeCwd}
        onOpenChange={setSkillOpen}
        onReloadPi={onReloadPi}
      />
    </div>
  );
}
