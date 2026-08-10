import { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

import { restoreViewportAfterSettle } from "./xtermViewportRestore";

export interface StockResizeSchedulerOptions {
  terminal: Terminal;
  fit: FitAddon;
  /** True while xterm still has unparsed writes (resizing mid-batch corrupts cursor state). */
  hasPendingWrites: () => boolean;
  /** Bytes still queued for xterm, if tracked. */
  pendingWriteBytes?: () => number;
  /** Queue an explicit FIFO write barrier; `onDrained` fires once the parser caught up. */
  queueWriteBarrier: (onDrained: () => void) => void;
  /** Longest the refit waits on the write barrier before proceeding anyway (default 100ms). */
  barrierCapMs?: number;
  /** Called after a successful fit with the new grid size (send the PTY resize here). */
  onFitted: (size: { cols: number; rows: number }) => void;
}

export interface StockResizeScheduler {
  schedule(): void;
  refitNow(): void;
  dispose(): void;
}

const SETTLE_FRAMES = 1;
const DEFAULT_BARRIER_CAP_MS = 100;
const DRAG_REFIT_INTERVAL_MS = 120;
const LARGE_WRITE_BYTES = 4096;

/** Exact resize policy used by the local master branch's terminal. */
export function createStockResizeScheduler(options: StockResizeSchedulerOptions): StockResizeScheduler {
  const { terminal, fit } = options;
  const barrierCapMs = options.barrierCapMs ?? DEFAULT_BARRIER_CAP_MS;

  let disposed = false;
  let restoreGeneration = 0;
  let deferredRefit = false;
  let refitBlockedAt = 0;
  let resizeBarrierQueued = false;
  let resizeSettleFrame: number | undefined;
  let transitionRefreshPending = false;

  const cancelPendingRestore = (): void => {
    restoreGeneration += 1;
  };

  const restoreAfterRefit = (wasAtBottom: boolean, topLine: number): void => {
    const generation = restoreGeneration;
    restoreViewportAfterSettle({
      terminal,
      wasAtBottom,
      topLine,
      isStale: () => disposed || generation !== restoreGeneration,
    });
  };

  const refit = (): void => {
    if (options.hasPendingWrites()) {
      if (!deferredRefit) {
        deferredRefit = true;
        refitBlockedAt = performance.now();
      }
      if (performance.now() - refitBlockedAt < barrierCapMs) {
        if (!resizeBarrierQueued) {
          resizeBarrierQueued = true;
          options.queueWriteBarrier(() => {
            resizeBarrierQueued = false;
            if (disposed || !deferredRefit) return;
            refitNow();
          });
        }
        return;
      }
    }
    deferredRefit = false;
    cancelPendingRestore();

    const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
    const topLine = terminal.buffer.active.viewportY;
    try {
      fit.fit();
    } catch {
      return;
    }
    if (wasAtBottom) terminal.scrollToBottom();
    options.onFitted({ cols: terminal.cols, rows: terminal.rows });
    restoreAfterRefit(wasAtBottom, topLine);
  };

  const fitLocal = (): void => {
    if (disposed) return;
    if ((options.pendingWriteBytes?.() ?? 0) > LARGE_WRITE_BYTES) return;
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

  const refitNow = (): void => {
    if (disposed) return;
    try {
      const dims = fit.proposeDimensions();
      if (!dims) return;
      if (dims.cols === terminal.cols && dims.rows === terminal.rows) return;
    } catch {
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
