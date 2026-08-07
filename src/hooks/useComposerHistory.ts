import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_PREFIX = "composer-history-v1:";
/** Cap the stored entries; the newest are kept. */
const HISTORY_LIMIT = 100;

function storageKey(cwd?: string): string {
  return `${STORAGE_PREFIX}${cwd?.trim() || "__global__"}`;
}

function readHistory(cwd?: string): string[] {
  try {
    const raw = window.localStorage.getItem(storageKey(cwd));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Per-project composer history: submitted messages recalled with ArrowUp /
 * ArrowDown. Persisted in localStorage under the project cwd so every session
 * of a project shares the same history (switching projects swaps it).
 *
 * Browse model (terminal-style): ArrowUp from an empty input (or from the
 * latest entry) walks back through the history; ArrowDown walks forward and,
 * past the newest entry, restores the text that was in the input when
 * browsing started. Editing a recalled entry keeps the browse position.
 */
export function useComposerHistory(cwd?: string) {
  const [history, setHistory] = useState<string[]>(() => readHistory(cwd));
  /** Index into `history` while browsing; -1 when not browsing. */
  const [browsingIndex, setBrowsingIndex] = useState(-1);
  /** Input text captured when browsing started; restored past the newest entry. */
  const draftRef = useRef<string | undefined>(undefined);

  // Switching projects swaps the history and leaves the browse session.
  useEffect(() => {
    setHistory(readHistory(cwd));
    setBrowsingIndex(-1);
    draftRef.current = undefined;
  }, [cwd]);

  const persist = useCallback(
    (next: string[]) => {
      try {
        window.localStorage.setItem(storageKey(cwd), JSON.stringify(next));
      } catch {
        // Storage unavailable — history just won't survive a restart.
      }
    },
    [cwd],
  );

  /** Record a sent message (trimmed, deduped against the previous entry). */
  const push = useCallback(
    (text: string) => {
      const value = text.trim();
      if (!value) return;
      setHistory((current) => {
        if (current[current.length - 1] === value) return current;
        const next = [...current, value].slice(-HISTORY_LIMIT);
        persist(next);
        return next;
      });
      setBrowsingIndex(-1);
      draftRef.current = undefined;
    },
    [persist],
  );

  /** Entry to show when stepping back; undefined keeps the default key behavior. */
  const stepUp = useCallback(
    (current: string): string | undefined => {
      if (history.length === 0) return undefined;
      if (browsingIndex < 0) {
        const latest = history[history.length - 1];
        // Only take over when the input is empty or already shows the latest
        // entry; otherwise ArrowUp keeps its caret behavior mid-edit.
        if (current.trim() !== "" && current !== latest) return undefined;
        draftRef.current = current;
        setBrowsingIndex(history.length - 1);
        return latest;
      }
      if (browsingIndex === 0) return history[0]; // oldest entry: stay put
      setBrowsingIndex(browsingIndex - 1);
      return history[browsingIndex - 1];
    },
    [history, browsingIndex],
  );

  /** Entry to show when stepping forward; restores the draft past the newest entry. */
  const stepDown = useCallback((): string | undefined => {
    if (browsingIndex < 0) return undefined;
    if (browsingIndex < history.length - 1) {
      setBrowsingIndex(browsingIndex + 1);
      return history[browsingIndex + 1];
    }
    setBrowsingIndex(-1);
    const draft = draftRef.current ?? "";
    draftRef.current = undefined;
    return draft;
  }, [history, browsingIndex]);

  return { push, stepUp, stepDown };
}
