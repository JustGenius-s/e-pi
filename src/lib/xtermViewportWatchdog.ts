import type { Terminal } from "@xterm/xterm";

export interface ViewportWatchdog {
  /** Run one reconciliation pass (also reschedules the interval timer). */
  check(): void;
  dispose(): void;
}

const WATCHDOG_INTERVAL_MS = 1000;

/** `window.setTimeout` in the renderer, plain `setTimeout` under vitest (node). */
const scheduleTimeout = (callback: () => void, ms: number): ReturnType<typeof setTimeout> =>
  typeof window === "undefined"
    ? setTimeout(callback, ms)
    : (window.setTimeout(callback, ms) as unknown as ReturnType<typeof setTimeout>);

const clearScheduleTimeout = (handle: ReturnType<typeof setTimeout> | undefined): void => {
  if (handle === undefined) return;
  if (typeof window === "undefined") clearTimeout(handle);
  else window.clearTimeout(handle as unknown as number);
};

/**
 * Periodically reconcile React/app scroll state with the xterm buffer.
 *
 * The terminal's `onScroll` event only fires when xterm's internal scroll
 * state actually changes value. If a state update ever gets clamped to the
 * value it already had (e.g. a resize-settle landing on scrollTop 0 while
 * the internal position was already 0), no event fires and state derived
 * from `onScroll` — like the "scroll to bottom" button visibility —
 * silently diverges from the real viewport.
 *
 * The watchdog re-derives `atBottom` from the buffer on a slow interval and
 * after explicit sync points (replay finished, session restart), never
 * trusting cached state. It deliberately never moves the viewport: xterm
 * clamps `viewportY` to `[0, baseY]` itself, and with smooth scrolling
 * disabled (see createXterm) the internal scrollable cannot drift past the
 * buffer — so any position correction would risk fighting the user's own
 * scrolling. Reconciliation of derived state is the safe, sufficient fix.
 */
export function createViewportWatchdog(
  terminal: Terminal,
  onAtBottomChange: (atBottom: boolean) => void,
  intervalMs = WATCHDOG_INTERVAL_MS,
): ViewportWatchdog {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const check = (): void => {
    if (disposed) return;
    const buffer = terminal.buffer.active;
    onAtBottomChange(buffer.viewportY >= buffer.baseY);
  };

  const schedule = (): void => {
    if (disposed) return;
    timer = scheduleTimeout(() => {
      check();
      schedule();
    }, intervalMs);
  };
  schedule();

  return {
    check() {
      if (disposed) return;
      clearScheduleTimeout(timer);
      check();
      schedule();
    },
    dispose() {
      disposed = true;
      clearScheduleTimeout(timer);
    },
  };
}
