import { useCallback, useEffect, useRef, useState } from "react";

import { preloadDiffHighlighter } from "../lib/diffPreload";
import type { GitDiffResult, GitFileEntry, GitStatus } from "../types/contracts";

export type GitReviewPhase = "idle" | "generating" | "committing" | "pushing" | "pulling";

export function useGitReview(cwd: string) {
  const [status, setStatus] = useState<GitStatus>();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [diffs, setDiffs] = useState<Record<string, GitDiffResult>>({});
  const [diffErrors, setDiffErrors] = useState<Record<string, string>>({});
  const [loadingPaths, setLoadingPaths] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState("");
  const [phase, setPhase] = useState<GitReviewPhase>("idle");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const lastAutoRefresh = useRef(0);
  const previousActivity = useRef<string>("idle");
  const loadingRef = useRef(new Set<string>());
  const cwdRef = useRef(cwd);

  useEffect(() => {
    cwdRef.current = cwd;
  }, [cwd]);

  const refresh = useCallback(async () => {
    if (!cwd) return;
    setError(undefined);
    try {
      setStatus(await window.ePi.git.status(cwd));
    } catch (reason) {
      setStatus(undefined);
      setDiffs({});
      setDiffErrors({});
      setExpanded(new Set());
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [cwd]);

  useEffect(() => {
    setMessage("");
    setNotice(undefined);
    setExpanded(new Set());
    setDiffs({});
    setDiffErrors({});
    void refresh();
  }, [cwd, refresh]);

  useEffect(() => {
    preloadDiffHighlighter();
  }, []);

  useEffect(() => {
    if (!cwd) return;
    return window.ePi.runtime.onState((next) => {
      if (next.cwd !== cwd) return;
      const wasBusy = previousActivity.current === "busy";
      previousActivity.current = next.activity ?? "idle";
      if (!wasBusy || next.activity !== "idle") return;
      const now = Date.now();
      if (now - lastAutoRefresh.current < 2_000) return;
      lastAutoRefresh.current = now;
      void refresh();
    });
  }, [cwd, refresh]);

  useEffect(() => {
    if (!cwd) return;
    void window.ePi.git.watchStart(cwd);
    const stop = window.ePi.git.onChanged((changedCwd) => {
      if (changedCwd === cwd) void refresh();
    });
    return () => {
      stop();
      void window.ePi.git.watchStop(cwd);
    };
  }, [cwd, refresh]);

  const loadDiff = useCallback(
    (path: string) => {
      if (loadingRef.current.has(path)) return;
      loadingRef.current.add(path);
      setLoadingPaths(new Set(loadingRef.current));
      const repoCwd = cwd;
      void window.ePi.git
        .diff(repoCwd, path)
        .then((result) => {
          if (cwdRef.current === repoCwd) setDiffs((current) => ({ ...current, [path]: result }));
        })
        .catch((reason: unknown) => {
          if (cwdRef.current === repoCwd)
            setDiffErrors((current) => ({
              ...current,
              [path]: reason instanceof Error ? reason.message : String(reason),
            }));
        })
        .finally(() => {
          loadingRef.current.delete(path);
          setLoadingPaths(new Set(loadingRef.current));
        });
    },
    [cwd],
  );

  const toggleFile = (entry: GitFileEntry) => {
    const path = entry.workPath;
    const willExpand = !expanded.has(path);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (willExpand) loadDiff(path);
  };

  const stage = async (entry: GitFileEntry) => {
    if (!cwd) return;
    setError(undefined);
    const result = entry.staged
      ? await window.ePi.git.unstage(cwd, [entry.workPath])
      : await window.ePi.git.stage(cwd, [entry.workPath]);
    if (!result.ok) setError(result.message);
    else setNotice(result.message);
    await refresh();
  };

  const stageAll = async () => {
    if (!cwd) return;
    setError(undefined);
    const result = await window.ePi.git.stage(cwd, []);
    if (!result.ok) setError(result.message);
    else setNotice(result.message);
    await refresh();
  };

  const unstageAll = async () => {
    if (!cwd) return;
    setError(undefined);
    const result = await window.ePi.git.unstage(cwd, []);
    if (!result.ok) setError(result.message);
    else setNotice(result.message);
    await refresh();
  };

  /** Generate a commit message with pi; returns the message or undefined on failure. */
  const generate = async (): Promise<string | undefined> => {
    if (!cwd || !status) return undefined;
    setPhase("generating");
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await window.ePi.git.generateMessage(cwd, status.stagedCount > 0);
      setMessage(result.message);
      setNotice(`Commit message generated with ${result.model}`);
      return result.message;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    } finally {
      setPhase("idle");
    }
  };

  const runGit = async (operation: "push" | "pull") => {
    if (!cwd) return;
    setPhase(operation === "push" ? "pushing" : "pulling");
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await window.ePi.git[operation](cwd);
      if (!result.ok) setError(result.message);
      else setNotice(result.message);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPhase("idle");
    }
  };

  /**
   * Commit the current changes. Auto-generates the message with pi when empty,
   * and stages everything when nothing is staged yet. When `pushAfter` is set,
   * pushes after a successful commit.
   */
  const commit = async (pushAfter = false): Promise<boolean> => {
    if (!cwd || !status) return false;
    setError(undefined);
    setNotice(undefined);
    try {
      let finalMessage: string | undefined = message.trim();
      if (!finalMessage) {
        finalMessage = await generate();
        if (!finalMessage) return false;
      }
      if (status.stagedCount === 0) {
        const staged = await window.ePi.git.stage(cwd, []);
        if (!staged.ok) {
          setError(staged.message);
          return false;
        }
      }
      setPhase("committing");
      const result = await window.ePi.git.commit(cwd, finalMessage);
      if (!result.ok) {
        setError(result.message);
        return false;
      }
      setNotice(result.message);
      setMessage("");
      if (pushAfter) {
        setPhase("pushing");
        const pushed = await window.ePi.git.push(cwd);
        if (!pushed.ok) {
          setError(pushed.message);
          return false;
        }
        setNotice(pushed.message);
      }
      await refresh();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setPhase("idle");
    }
  };

  return {
    status,
    expanded,
    diffs,
    diffErrors,
    loadingPaths,
    message,
    phase,
    error,
    notice,
    setMessage,
    setError,
    setNotice,
    setExpanded,
    loadDiff,
    toggleFile,
    stage,
    stageAll,
    unstageAll,
    generate,
    commit,
    push: () => runGit("push"),
    pull: () => runGit("pull"),
    refresh,
    busy: phase !== "idle",
  };
}
