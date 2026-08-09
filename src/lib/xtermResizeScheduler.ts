import { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

import { restoreViewportAfterSettle } from "./xtermViewportRestore";

export interface ResizeSchedulerOptions {
  terminal: Terminal;
  fit: FitAddon;
  /** True while xterm still has writes ahead of a FIFO barrier. */
  hasPendingWrites: () => boolean;
  /** Queue a FIFO parser barrier; the callback runs after earlier writes parse. */
  queueWriteBarrier: (onDrained: () => void) => void;
  /** Freeze output and cover the live renderer before one authoritative step. */
  onResizeStart?: () => void;
  /** The hidden xterm grid now matches the step target and can be snapshotted. */
  onResizePreviewReady?: () => void;
  /** Arm the output gate before the PTY receives this resize. */
  onResizeCommit?: (size: TerminalSize) => void;
  /** A prepared step collapsed back to the acknowledged PTY grid. */
  onResizeCancel?: () => void;
  /** The latest acknowledged grid stayed stable for two paint frames. */
  onResizeSettled?: () => void;
  /** Send one authoritative PTY resize. */
  onFitted: (size: TerminalSize) => void;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface ResizeScheduler {
  /** Record the latest container/font measurement. */
  schedule(): void;
  /** Fit and assert the initial PTY grid immediately. */
  refitNow(): void;
  /** A full frame for the latest PTY resize was atomically presented. */
  acknowledgeResize(): boolean;
  dispose(): void;
}

/** Quiet time only controls snapshot release; it never delays a PTY resize. */
const QUIET_FRAMES = 2;
const MAX_UNMEASURABLE_FRAMES = 60;

/**
 * Preemptible latest-wins resize coordination for a fullscreen TUI.
 *
 * The first measurable grid change is fitted and sent to the PTY on the next
 * animation frame. Later ResizeObserver notifications can supersede a resize
 * whose authoritative Pi frame has not arrived yet: xterm locally refits to
 * the newest grid, the output gate changes its expected frame tag, and another
 * PTY resize is sent immediately. A late frame for an older grid is discarded
 * before it reaches xterm. If an old frame already entered xterm's FIFO parser,
 * a short parser barrier is the only thing allowed to delay the next fit.
 */
export function createResizeScheduler(options: ResizeSchedulerOptions): ResizeScheduler {
  const { terminal, fit } = options;

  let disposed = false;
  let frame: number | undefined;
  let observationEpoch = 0;
  let processedEpoch = -1;
  let quietFrames = 0;
  let unmeasurableFrames = 0;

  let transactionActive = false;
  let stepPreparing = false;
  let transactionWasAtBottom = true;
  let transactionTopLine = 0;

  /** Last grid whose authoritative frame has been presented. */
  let committedSize: TerminalSize | undefined;
  /** Latest PTY resize awaiting an authoritative frame. */
  let inFlightSize: TerminalSize | undefined;
  let restoreGeneration = 0;

  let barrierQueued = false;
  let barrierPermit = false;
  let immediateRefitPending = false;

  const sameSize = (left: TerminalSize, right: TerminalSize): boolean =>
    left.cols === right.cols && left.rows === right.rows;

  const currentSize = (): TerminalSize => ({ cols: terminal.cols, rows: terminal.rows });

  const cancelPendingRestore = (): void => {
    restoreGeneration += 1;
  };

  const restoreAnchorNow = (): void => {
    if (transactionWasAtBottom) {
      terminal.scrollToBottom();
    } else if (terminal.buffer.active.viewportY !== transactionTopLine) {
      terminal.scrollToLine(transactionTopLine);
    }
  };

  const restoreAnchorAfterSettle = (): void => {
    const generation = restoreGeneration;
    restoreViewportAfterSettle({
      terminal,
      wasAtBottom: transactionWasAtBottom,
      topLine: transactionTopLine,
      isStale: () => disposed || generation !== restoreGeneration,
    });
  };

  const ensureFrame = (): void => {
    if (disposed || frame !== undefined) return;
    frame = requestAnimationFrame(settleStep);
  };

  const queueParserBarrier = (): void => {
    if (barrierQueued || disposed) return;
    barrierQueued = true;
    options.queueWriteBarrier(() => {
      barrierQueued = false;
      if (disposed) return;
      // The barrier grants one parser-ordered geometry change. Output arriving
      // behind it is already isolated by onResizeStart's output gate.
      barrierPermit = true;
      if (immediateRefitPending) {
        immediateRefitPending = false;
        refitNow();
      }
      ensureFrame();
    });
  };

  const acquireParserPermit = (): boolean => {
    if (barrierPermit) {
      barrierPermit = false;
      return true;
    }
    if (!options.hasPendingWrites()) return true;
    queueParserBarrier();
    return false;
  };

  const propose = (): TerminalSize | undefined => {
    try {
      const dimensions = fit.proposeDimensions();
      if (!dimensions || dimensions.cols <= 0 || dimensions.rows <= 0) return undefined;
      return { cols: dimensions.cols, rows: dimensions.rows };
    } catch {
      return undefined;
    }
  };

  const beginTransaction = (): void => {
    if (transactionActive) return;
    transactionActive = true;
    transactionWasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
    transactionTopLine = terminal.buffer.active.viewportY;
    cancelPendingRestore();
  };

  const prepareStep = (): void => {
    beginTransaction();
    if (stepPreparing) return;
    stepPreparing = true;
    options.onResizeStart?.();
  };

  const finishTransaction = (cancelled: boolean): void => {
    if (!transactionActive) return;
    transactionActive = false;
    stepPreparing = false;
    quietFrames = 0;
    unmeasurableFrames = 0;
    cancelPendingRestore();
    restoreAnchorAfterSettle();
    if (cancelled) options.onResizeCancel?.();
    else options.onResizeSettled?.();
  };

  const fitAndSendLatest = (target: TerminalSize): "sent" | "waiting" | "retry" | "cancelled" => {
    prepareStep();
    if (!acquireParserPermit()) return "waiting";

    if (!sameSize(currentSize(), target)) {
      try {
        fit.fit();
      } catch {
        return "retry";
      }
      restoreAnchorNow();
    }

    const size = currentSize();
    options.onResizePreviewReady?.();

    // The container may have reversed while a parser barrier was draining.
    // Flush the held output instead of sending a redundant round trip.
    if (!inFlightSize && committedSize && sameSize(size, committedSize)) {
      finishTransaction(true);
      return "cancelled";
    }

    stepPreparing = false;
    inFlightSize = size;
    quietFrames = 0;
    // Gate first, then SIGWINCH: no byte from the new frame can race ahead of
    // the checkpoint expectation.
    options.onResizeCommit?.(size);
    options.onFitted(size);
    return "sent";
  };

  function settleStep(): void {
    frame = undefined;
    if (disposed) return;

    const epoch = observationEpoch;
    if (epoch === processedEpoch) quietFrames += 1;
    else {
      processedEpoch = epoch;
      quietFrames = 0;
    }

    const target = propose();
    if (!target) {
      unmeasurableFrames += 1;
      if (transactionActive && unmeasurableFrames >= MAX_UNMEASURABLE_FRAMES) {
        finishTransaction(true);
        return;
      }
      if (transactionActive || stepPreparing) ensureFrame();
      return;
    }
    unmeasurableFrames = 0;

    const gridDiffers = !sameSize(currentSize(), target);
    const latestPtySize = inFlightSize ?? committedSize;
    const ptyDiffers = latestPtySize === undefined || !sameSize(latestPtySize, target);
    if (gridDiffers || ptyDiffers || stepPreparing) {
      quietFrames = 0;
      const result = fitAndSendLatest(target);
      if (result === "retry") ensureFrame();
      // A parser barrier callback resumes "waiting". A sent step resumes on
      // either a newer observation (preemption) or its checkpoint callback.
      return;
    }

    // The latest grid is already fitted and asserted. Its checkpoint controls
    // presentation and settle; quiet observations must never release the guard
    // while that authoritative frame is still outstanding.
    if (inFlightSize) return;

    if (!transactionActive) return;
    if (observationEpoch !== epoch) quietFrames = 0;
    if (quietFrames >= QUIET_FRAMES) {
      finishTransaction(false);
      return;
    }
    ensureFrame();
  }

  const schedule = (): void => {
    if (disposed) return;
    observationEpoch += 1;
    ensureFrame();
  };

  const refitNow = (): void => {
    if (disposed) return;
    const target = propose();
    if (!target) return;

    const gridChanged = !sameSize(currentSize(), target);
    if (gridChanged) {
      if (!acquireParserPermit()) {
        immediateRefitPending = true;
        return;
      }
      transactionWasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
      transactionTopLine = terminal.buffer.active.viewportY;
      cancelPendingRestore();
      try {
        fit.fit();
      } catch {
        ensureFrame();
        return;
      }
      restoreAnchorNow();
      restoreAnchorAfterSettle();
    }

    const size = currentSize();
    // Initial mount must always assert its real grid, even when xterm's 80x24
    // default happens to equal the measured dimensions.
    if (committedSize === undefined || !sameSize(size, committedSize)) {
      options.onFitted(size);
      committedSize = size;
    }
  };

  return {
    schedule,
    refitNow,
    acknowledgeResize() {
      if (disposed || !inFlightSize) return false;
      committedSize = inFlightSize;
      inFlightSize = undefined;
      quietFrames = 0;
      restoreAnchorNow();
      ensureFrame();
      return true;
    },
    dispose() {
      disposed = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      inFlightSize = undefined;
      stepPreparing = false;
      cancelPendingRestore();
    },
  };
}
