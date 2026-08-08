import { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

import { restoreViewportAfterSettle } from "./xtermViewportRestore";

export interface ResizeSchedulerOptions {
  terminal: Terminal;
  fit: FitAddon;
  /** True while xterm still has unparsed writes (resizing mid-batch corrupts cursor state). */
  hasPendingWrites: () => boolean;
  /** Queue an explicit FIFO write barrier; `onDrained` fires once the parser caught up. */
  queueWriteBarrier: (onDrained: () => void) => void;
  /** Longest the refit waits on the write barrier before proceeding anyway (default 100ms). */
  barrierCapMs?: number;
  /** Called after a successful fit with the new grid size (send the PTY resize here). */
  onFitted: (size: { cols: number; rows: number }) => void;
}

export interface ResizeScheduler {
  /** Call from the ResizeObserver: restart settle detection (refits ~2 stable frames later). */
  schedule(): void;
  /** Fit immediately if the grid changed (first mount, write-barrier drain). */
  refitNow(): void;
  dispose(): void;
}

const SETTLE_FRAMES = 1;
const DEFAULT_BARRIER_CAP_MS = 100;
/** While the size keeps changing (drag), refit at most this often. */
const DRAG_REFIT_INTERVAL_MS = 120;

/**
 * Shared resize handling for the main TUI terminal and the side terminal.
 *
 * The panel collapse/expand transition animates the container width over
 * ~180ms, so the grid size changes every frame and then goes stable. Instead
 * of a fixed debounce (which adds dead time after the transition), watch the
 * proposed grid per frame and refit once it has been stable for two frames —
 * typically ~33ms after the size settles. While the transition is still
 * running, repaint the current screen at the new container width (WebGL
 * repositions glyph quads, no reflow) so the user never stares at a frozen
 * old-layout frame.
 *
 * Refits respect xterm's asynchronous parser: resizing while a write batch
 * is in flight makes the producer and emulator disagree about cursor
 * coordinates. A write barrier defers the fit until the parser drains, but
 * the wait is capped so a sustained output stream cannot starve the resize
 * forever (the TUI's resize-triggered full redraw heals any transient
 * mismatch).
 */
export function createResizeScheduler(options: ResizeSchedulerOptions): ResizeScheduler {
  const { terminal, fit } = options;
  const barrierCapMs = options.barrierCapMs ?? DEFAULT_BARRIER_CAP_MS;

  let disposed = false;
  let restoreGeneration = 0;
  let deferredRefit = false;
  let refitBlockedAt = 0;
  let resizeBarrierQueued = false;
  let resizeSettleFrame: number | undefined;
  let transitionRefreshPending = false;

  // Bump the generation so any in-flight viewport restore from a previous
  // refit aborts at its next frame check. cancelAnimationFrame cannot stop a
  // callback that is already executing (it would reschedule itself), so the
  // generation check inside the restore loop is the real guard.
  const cancelPendingRestore = (): void => {
    restoreGeneration += 1;
  };

  const refit = (): void => {
    // xterm parses writes asynchronously. Resizing while a TUI frame is still
    // queued makes the producer and emulator disagree about cursor
    // coordinates; the next spinner update can then scroll instead of
    // replacing its row. Wait until the current write batch is committed —
    // but cap the wait: under sustained output the barrier could starve the
    // refit indefinitely, and the TUI's next full frame corrects any
    // transient mismatch anyway.
    if (options.hasPendingWrites()) {
      if (!deferredRefit) {
        deferredRefit = true;
        refitBlockedAt = performance.now();
      }
      if (performance.now() - refitBlockedAt < barrierCapMs) {
        if (!resizeBarrierQueued) {
          resizeBarrierQueued = true;
          // An empty write is an explicit FIFO barrier behind all terminal
          // data queued so far. This prevents a sustained stream from
          // starving resize forever while preserving parser ordering.
          options.queueWriteBarrier(() => {
            resizeBarrierQueued = false;
            if (disposed || !deferredRefit) return;
            refitNow();
          });
        }
        return;
      }
      // Cap exceeded: refit now even with writes in flight.
    }
    deferredRefit = false;

    // A previous refit may still have a delayed restoration queued. If it
    // runs after this refit, its old line number can move the viewport to
    // the wrong place (including the top) after a second reflow.
    cancelPendingRestore();

    // Capture the viewport by line, not pixel: reflow re-wraps the whole
    // scrollback, so a pixel offset no longer maps to the same content
    // (and the browser/xterm may clamp it to the new scroll height, which
    // is the "jumps back to top" bug). Line numbers survive reflow.
    const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
    const topLine = terminal.buffer.active.viewportY;
    try {
      fit.fit();
    } catch {
      return;
    }
    // Re-assert the bottom immediately: the renderer already repainted at
    // the new grid, but xterm's own viewport sync only runs on the next
    // refresh frame — without this the user briefly sees the top of the
    // reflowed buffer instead of the live tail they were following.
    if (wasAtBottom) terminal.scrollToBottom();
    options.onFitted({ cols: terminal.cols, rows: terminal.rows });
    restoreAfterRefit(wasAtBottom, topLine);
  };

  /**
   * Local-only refit: reflows xterm's buffer at the new grid instantly but
   * does NOT resize the PTY, so pi never sees it. Used while the size keeps
   * changing (drag): xterm's sync reflow is pure character rewrapping — far
   * cheaper than pi's full component-tree re-render — so the layout follows
   * the drag at frame rate. pi only receives the throttled PTY resizes (see
   * settleStep) and the final settle refit, which correct any drift.
   * xterm tolerates resize while its write queue is draining, so no write
   * barrier is needed here (it would only add latency).
   */
  const fitLocal = (): void => {
    if (disposed) return;
    cancelPendingRestore();
    const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
    const topLine = terminal.buffer.active.viewportY;
    try {
      fit.fit();
    } catch {
      return;
    }
    if (wasAtBottom) terminal.scrollToBottom();
    restoreAfterRefit(wasAtBottom, topLine);
  };

  const restoreAfterRefit = (wasAtBottom: boolean, topLine: number): void => {
    // xterm's resize schedules its own viewport sync on a refresh callback
    // (viewport.queueSync -> _sync on rAF) that runs on a later frame; in
    // v6 that sync can leave the scrollable on a stale/clamped position
    // instead of the buffer's ydisp. Restore only once the viewport has
    // stopped moving on its own, so the restore lands after xterm's sync
    // instead of racing it. The stale check makes a newer refit (or
    // unmount) abort the loop at the next frame.
    const generation = restoreGeneration;
    restoreViewportAfterSettle({
      terminal,
      wasAtBottom,
      topLine,
      isStale: () => disposed || generation !== restoreGeneration,
    });
  };

  const refitNow = (): void => {
    if (disposed) return;
    try {
      // Skip the refit when the character grid did not change (e.g.
      // sub-pixel width wobble) — resizing repaints the renderer.
      const dims = fit.proposeDimensions();
      if (!dims) return;
      if (dims.cols === terminal.cols && dims.rows === terminal.rows) return;
    } catch {
      // The terminal can be measured before its parent is visible.
      return;
    }
    refit();
  };

  const schedule = (): void => {
    if (disposed) return;
    if (resizeSettleFrame !== undefined) cancelAnimationFrame(resizeSettleFrame);
    let lastCols = -1;
    let lastRows = -1;
    let stableFrames = 0;
    let lastDragRefitAt = 0;
    const settleStep = (): void => {
      resizeSettleFrame = undefined;
      if (disposed) return;
      if (transitionRefreshPending) {
        transitionRefreshPending = false;
        terminal.refresh(0, terminal.rows - 1);
      }
      let cols = -1;
      let rows = -1;
      try {
        const dims = fit.proposeDimensions();
        if (dims) {
          cols = dims.cols;
          rows = dims.rows;
        }
      } catch {
        // Not measurable this frame; treat as unsettled.
      }
      if (cols === lastCols && rows === lastRows) {
        stableFrames += 1;
      } else {
        lastCols = cols;
        lastRows = rows;
        stableFrames = 0;
        // The size keeps changing (panel drag / window resize): reflow
        // xterm locally on every frame so the layout tracks the drag at
        // frame rate (cheap character rewrapping), and send the PTY resize
        // at a throttled rate so pi re-renders the authoritative frame.
        fitLocal();
        const now = performance.now();
        if (now - lastDragRefitAt >= DRAG_REFIT_INTERVAL_MS) {
          lastDragRefitAt = now;
          refit();
        }
      }
      if (stableFrames >= SETTLE_FRAMES) {
        refit();
        return;
      }
      resizeSettleFrame = requestAnimationFrame(settleStep);
    };
    // The repaint-on-transition-start must not double-paint when a settle
    // loop is already running (its first frame refreshes too).
    transitionRefreshPending = transitionRefreshPending || resizeSettleFrame === undefined;
    resizeSettleFrame = requestAnimationFrame(settleStep);
  };

  return {
    schedule,
    refitNow,
    dispose() {
      disposed = true;
      if (resizeSettleFrame !== undefined) cancelAnimationFrame(resizeSettleFrame);
      resizeSettleFrame = undefined;
      cancelPendingRestore();
    },
  };
}
