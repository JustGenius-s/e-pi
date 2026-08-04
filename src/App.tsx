import { useEffect, useMemo, useState } from "react";
import { FolderOpen, Terminal, X } from "lucide-react";
import { AppDialogs } from "./components/AppDialogs";
import { AppHeader } from "./components/AppHeader";
import { Composer } from "./components/Composer";
import { IconButton } from "./components/IconButton";
import { PackagePanel } from "./components/PackagePanel";
import { SessionSidebar } from "./components/SessionSidebar";
import { SkillPanel } from "./components/SkillPanel";
import { TerminalPanel } from "./components/TerminalPanel";
import type { AppInfo, PiRuntimeState, SessionSummary } from "./types/contracts";
import { Button } from "./components/ui/button";
import { SidebarInset, SidebarProvider } from "./components/ui/sidebar";

export function App() {
  const [appInfo, setAppInfo] = useState<AppInfo>();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activePath, setActivePath] = useState<string>();
  const [runtimeState, setRuntimeState] = useState<PiRuntimeState>({ status: "idle" });
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
  const activeCwd = runtimeState.cwd || activeSession?.cwd || appInfo?.defaultCwd || "";

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
      window.ePi.runtime.getState(),
    ])
      .then(([info, nextSessions, state]) => {
        if (!active) return;
        setAppInfo(info);
        setSessions(nextSessions);
        setRuntimeState(state);
        setActivePath(state.sessionPath || nextSessions[0]?.path);
        setLoading(false);
        window.ePi.app.log(`[app] init sessions=${nextSessions.length} state=${JSON.stringify({ status: state.status, sessionPath: state.sessionPath })}`);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setLoading(false);
      });
    const stopState = window.ePi.runtime.onState((state) => {
      window.ePi.app.log(`[app] onState ${JSON.stringify({ status: state.status, sessionPath: state.sessionPath })}`);
      setRuntimeState(state);
    });
    return () => {
      active = false;
      stopState();
    };
  }, []);

  useEffect(() => {
    if (loading || !activePath || runtimeState.sessionPath === activePath) {
      window.ePi.app.log(
        `[app] switch effect SKIP loading=${loading} activePath=${activePath} sessionPath=${runtimeState.sessionPath}`,
      );
      return;
    }
    window.ePi.app.log(
      `[app] switch effect START activePath=${activePath} prevSessionPath=${runtimeState.sessionPath}`,
    );
    void window.ePi.runtime.start(activePath).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [activePath, loading, runtimeState.sessionPath]);

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

  const createSession = async (cwd?: string) => {
    setError(undefined);
    const targetCwd = cwd ?? (await window.ePi.app.chooseDirectory(activeCwd || undefined));
    if (!targetCwd) return;
    try {
      const session = await window.ePi.sessions.create({ cwd: targetCwd });
      window.ePi.app.log(`[app] createSession created=${session.path} cwd=${targetCwd}`);
      setSessions((current) => [session, ...current]);
      setActivePath(session.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const selectSession = (session: SessionSummary) => {
    setError(undefined);
    window.ePi.app.log(`[app] selectSession ${session.path}`);
    setActivePath(session.path);
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

  const submit = async (text: string) => {
    setError(undefined);
    window.ePi.app.log(`[app] submit status=${runtimeState.status} text=${text.slice(0, 60)}`);
    try {
      await window.ePi.runtime.submit(text);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
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
      await window.ePi.runtime.stop();
      await window.ePi.runtime.start(activePath);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <div className="app-shell">
      <SidebarProvider className="app-content">
        <AppHeader
          activeSession={activeSession}
          activeCwd={activeCwd}
          onOpenWorkingFolder={() => activeCwd && void window.ePi.app.openPath(activeCwd)}
        />

        <div className="app-main">
          <SessionSidebar
            sessions={sessions}
            activePath={activePath}
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
                <TerminalPanel sessionKey={activeSession.path} runtimeState={runtimeState} />
              ) : (
                <div className="workspace-empty">
                  <div className="empty-terminal-icon">
                    <Terminal size={20} />
                  </div>
                  <h3>Start a Pi session</h3>
                  <p>Choose a working folder and let Pi take the terminal from there.</p>
                  <Button onClick={() => void createSession()}>
                    <FolderOpen size={15} /> Choose folder
                  </Button>
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
              status={runtimeState.status}
              cwd={activeCwd}
              disabled={
                !activeSession ||
                runtimeState.status === "starting" ||
                runtimeState.status === "stopping" ||
                runtimeState.status === "error" ||
                runtimeState.status === "exited"
              }
              onSubmit={submit}
              onInterrupt={() => window.ePi.runtime.interrupt()}
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
        onReloadPi={reloadPi}
      />
      <SkillPanel
        open={skillOpen}
        cwd={activeCwd}
        onOpenChange={setSkillOpen}
        onReloadPi={reloadPi}
      />
    </div>
  );
}
