import type { Terminal } from "@xterm/xterm";

export interface ViewportRestoreOptions {
  terminal: Terminal;
  /** The viewport was following output before the refit. */
  wasAtBottom: boolean;
  /** Captured viewport line before the refit. */
  topLine: number;
  /** Becomes true when the terminal was disposed or a newer refit superseded this one. */
  isStale: () => boolean;
}

/**
 * Restore the viewport after a refit reflowed the scrollback.
 *
 * Xterm's resize does not update the viewport synchronously: it queues a sync
 * on the render service's refresh callback (`viewport.queueSync -> _sync`),
 * which runs on a later frame. In xterm v6 that sync goes through the
 * scrollable's smooth-scroll path (`combine`/`reuseAnimation`), which can
 * leave the internal scroll state at a stale/clamped value (0 when the
 * scrollHeight was still 0) instead of the buffer's `ydisp` — the
 * intermittent "jumps to top" bug. So instead of restoring after a fixed
 * number of frames, wait until the viewport stops moving on its own — that
 * means xterm's queued sync has run and any stale position has propagated
 * into `ydisp` — then restore once. One extra frame afterwards corrects a
 * straggler sync that ran after the restore.
 *
 * Bounded: gives up after 60 frames (~1s) and restores anyway. Every frame
 * checks `isStale` so a disposed terminal or a newer refit (with its own
 * line numbers) never gets overwritten.
 */
export function restoreViewportAfterSettle({ terminal, wasAtBottom, topLine, isStale }: ViewportRestoreOptions): void {
  const MAX_FRAMES = 60;
  const SETTLE_FRAMES = 2;
  const DRIFT_TOLERANCE = 5;

  let lastY = terminal.buffer.active.viewportY;
  let stableFrames = 0;
  let frames = 0;

  const restore = () => {
    if (isStale()) return;
    if (wasAtBottom) {
      terminal.scrollToBottom();
    } else if (Math.abs(terminal.buffer.active.viewportY - topLine) > DRIFT_TOLERANCE) {
      terminal.scrollToLine(topLine);
    }
  };

  const step = () => {
    if (isStale()) return;
    const y = terminal.buffer.active.viewportY;
    if (y === lastY) {
      stableFrames += 1;
    } else {
      lastY = y;
      stableFrames = 0;
    }
    frames += 1;
    if (stableFrames >= SETTLE_FRAMES || frames >= MAX_FRAMES) {
      restore();
      // Straggler guard: xterm may have queued one more sync that runs after
      // the restore; correct it once if it moved the viewport again.
      requestAnimationFrame(() => {
        if (isStale()) return;
        if (wasAtBottom) {
          if (terminal.buffer.active.viewportY < terminal.buffer.active.baseY) terminal.scrollToBottom();
        } else if (Math.abs(terminal.buffer.active.viewportY - topLine) > DRIFT_TOLERANCE) {
          terminal.scrollToLine(topLine);
        }
      });
      return;
    }
    requestAnimationFrame(step);
  };

  requestAnimationFrame(step);
}
