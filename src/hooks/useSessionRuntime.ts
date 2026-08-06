import { useCallback, useEffect, useRef, useState } from "react";

import { clearTerminalBuffer } from "@/components/workspace/TerminalPanel";

import type { AppInfo, PiRuntimeState, SessionSummary } from "../types/contracts";

export function useSessionRuntime() {
  const [appInfo, setAppInfo] = useState<AppInfo>();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activePath, setActivePath] = useState<string>();
  const [runtimeStates, setRuntimeStates] = useState<Record<string, PiRuntimeState>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const runtimeStatesRef = useRef(runtimeStates);
  runtimeStatesRef.current = runtimeStates;

  const refreshSessions = useCallback(async () => {
    try {
      const next = await window.ePi.sessions.list();
      setSessions(next);
      setActivePath((current) =>
        current && next.some((session) => session.path === current) ? current : next[0]?.path,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  const refreshAppInfo = useCallback(async () => {
    try {
      setAppInfo(await window.ePi.app.getInfo());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  const activate = useCallback(async (path: string): Promise<void> => {
    setError(undefined);
    const target = runtimeStatesRef.current[path];
    const needsFreshStart =
      !target || target.status === "idle" || target.status === "exited" || target.status === "error";
    if (needsFreshStart) clearTerminalBuffer(path);
    await window.ePi.runtime.start(path);
  }, []);

  useEffect(() => {
    let mounted = true;
    Promise.all([window.ePi.app.getInfo(), window.ePi.sessions.list(), window.ePi.runtime.getStates()])
      .then(([info, nextSessions, states]) => {
        if (!mounted) return;
        setAppInfo(info);
        setSessions(nextSessions);
        setRuntimeStates(states);
        setActivePath(nextSessions[0]?.path);
        setLoading(false);
        window.ePi.app.log(`[app] init sessions=${nextSessions.length} states=${Object.keys(states).length}`);
        if (nextSessions[0])
          void window.ePi.runtime
            .start(nextSessions[0].path)
            .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
      })
      .catch((reason: unknown) => {
        if (!mounted) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setLoading(false);
      });
    const stopState = window.ePi.runtime.onState((state) => {
      window.ePi.app.log(`[app] onState ${JSON.stringify({ status: state.status, sessionPath: state.sessionPath })}`);
      setRuntimeStates((current) => ({ ...current, [state.sessionPath]: state }));
    });
    // The main process pushes a fresh list when a session file changes (first
    // message, title, recency), so the sidebar never sits on a stale title.
    const stopSessionsUpdated = window.ePi.sessions.onUpdated((next) => {
      setSessions(next);
      setActivePath((current) =>
        current && next.some((session) => session.path === current) ? current : next[0]?.path,
      );
    });
    return () => {
      mounted = false;
      stopState();
      stopSessionsUpdated();
    };
  }, []);

  return {
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
  };
}
