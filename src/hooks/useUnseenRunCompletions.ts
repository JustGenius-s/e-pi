import { useEffect, useRef, useState } from "react";

import type { PiRuntimeState } from "../types/contracts";

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

/**
 * Sessions whose background run finished while another session was active.
 * A session is marked when its agent activity flips busy → idle (or the pi
 * process exits) while it is not the active session — the sidebar then shows
 * a blue navigation dot on the row. Selecting the session or a new run
 * starting clears the mark.
 *
 * The mark lives here (not derived per render) so it survives re-renders and
 * only clears through the three explicit paths above.
 */
export function useUnseenRunCompletions(
  runtimeStates: Record<string, PiRuntimeState>,
  activePath?: string,
): ReadonlySet<string> {
  const [unseen, setUnseen] = useState<ReadonlySet<string>>(() => new Set());
  const previousRef = useRef<Record<string, PiRuntimeState>>({});

  useEffect(() => {
    const previous = previousRef.current;
    setUnseen((current) => {
      const next = new Set(current);
      for (const path of new Set([...Object.keys(runtimeStates), ...Object.keys(previous)])) {
        const before = previous[path];
        const after = runtimeStates[path];

        if (path === activePath) {
          // The user is looking at this session: nothing to cue, and any
          // previous mark (e.g. it finished while another session was open
          // and the user just switched to it) is consumed.
          next.delete(path);
          continue;
        }

        const wasRunning = before?.status === "running" && before.activity === "busy";
        const finishedNow = (after?.status === "running" && after.activity === "idle") || after?.status === "exited";

        if (wasRunning && finishedNow) {
          // A background run completed: cue the row.
          next.add(path);
        } else if (after?.status === "running" && after.activity === "busy") {
          // A new run started: the cue waits for this run to finish.
          next.delete(path);
        }
      }
      return sameSet(current, next) ? current : next;
    });
    previousRef.current = runtimeStates;
  }, [runtimeStates, activePath]);

  return unseen;
}
