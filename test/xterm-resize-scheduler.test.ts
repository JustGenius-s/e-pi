import { afterEach, describe, expect, it, vi } from "vitest";

import { createResizeScheduler } from "../src/lib/xtermResizeScheduler";

interface FakeBuffer {
  viewportY: number;
  baseY: number;
}

interface FakeTerminal {
  cols: number;
  rows: number;
  buffer: { active: FakeBuffer };
  scrollToBottom: ReturnType<typeof vi.fn>;
  scrollToLine: ReturnType<typeof vi.fn>;
}

function makeTerminal(cols = 80, rows = 24, viewportY = 0, baseY = 0): FakeTerminal {
  const buffer: FakeBuffer = { viewportY, baseY };
  return {
    cols,
    rows,
    buffer: { active: buffer },
    scrollToBottom: vi.fn(() => {
      buffer.viewportY = buffer.baseY;
    }),
    scrollToLine: vi.fn((line: number) => {
      buffer.viewportY = line;
    }),
  };
}

function makeFit(terminal: FakeTerminal, proposed: () => { cols: number; rows: number }) {
  return {
    proposeDimensions: vi.fn(proposed),
    fit: vi.fn(() => {
      const dimensions = proposed();
      terminal.cols = dimensions.cols;
      terminal.rows = dimensions.rows;
    }),
  };
}

type FrameCallback = () => void;

function installFrameRunner() {
  let queue = new Map<number, FrameCallback>();
  let nextId = 1;
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameCallback) => {
      const id = nextId;
      nextId += 1;
      queue.set(id, callback);
      return id;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => queue.delete(id)),
  );
  return {
    runFrames(count: number) {
      for (let index = 0; index < count; index += 1) {
        const pending = queue;
        queue = new Map();
        for (const callback of pending.values()) callback();
      }
    },
    scheduledFrames() {
      return queue.size;
    },
  };
}

function setup(proposed: () => { cols: number; rows: number }, terminal = makeTerminal()) {
  const fit = makeFit(terminal, proposed);
  const onResizeStart = vi.fn();
  const onResizePreviewReady = vi.fn();
  const onResizeCommit = vi.fn();
  const onResizeCancel = vi.fn();
  const onResizeSettled = vi.fn();
  const onFitted = vi.fn();
  let pendingWrites = false;
  let barrier: (() => void) | undefined;
  const queueWriteBarrier = vi.fn((callback: () => void) => {
    barrier = callback;
  });
  const scheduler = createResizeScheduler({
    terminal: terminal as never,
    fit: fit as never,
    hasPendingWrites: () => pendingWrites,
    queueWriteBarrier,
    onResizeStart,
    onResizePreviewReady,
    onResizeCommit,
    onResizeCancel,
    onResizeSettled,
    onFitted,
  });
  return {
    terminal,
    fit,
    scheduler,
    onResizeStart,
    onResizePreviewReady,
    onResizeCommit,
    onResizeCancel,
    onResizeSettled,
    onFitted,
    queueWriteBarrier,
    setPendingWrites(value: boolean) {
      pendingWrites = value;
    },
    drainBarrier() {
      barrier?.();
      barrier = undefined;
    },
  };
}

function initialize(result: ReturnType<typeof setup>): void {
  result.scheduler.refitNow();
  result.fit.fit.mockClear();
  result.onResizeStart.mockClear();
  result.onResizePreviewReady.mockClear();
  result.onResizeCommit.mockClear();
  result.onResizeCancel.mockClear();
  result.onResizeSettled.mockClear();
  result.onFitted.mockClear();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createResizeScheduler", () => {
  it("asserts the initial PTY size even when xterm already has that grid", () => {
    installFrameRunner();
    const result = setup(() => ({ cols: 80, rows: 24 }));

    result.scheduler.refitNow();

    expect(result.fit.fit).not.toHaveBeenCalled();
    expect(result.onFitted).toHaveBeenCalledOnce();
    expect(result.onFitted).toHaveBeenCalledWith({ cols: 80, rows: 24 });
  });

  it("fits and asserts a changed initial grid immediately", () => {
    installFrameRunner();
    const result = setup(() => ({ cols: 100, rows: 30 }));

    result.scheduler.refitNow();

    expect(result.fit.fit).toHaveBeenCalledOnce();
    expect(result.terminal).toMatchObject({ cols: 100, rows: 30 });
    expect(result.onFitted).toHaveBeenCalledWith({ cols: 100, rows: 30 });
  });

  it("sends a jump resize on the first animation frame without waiting to settle", () => {
    const { runFrames } = installFrameRunner();
    let proposed = { cols: 80, rows: 24 };
    const result = setup(() => proposed);
    initialize(result);

    proposed = { cols: 120, rows: 30 };
    result.scheduler.schedule();
    runFrames(1);

    expect(result.fit.fit).toHaveBeenCalledOnce();
    expect(result.onResizeStart).toHaveBeenCalledOnce();
    expect(result.onResizePreviewReady).toHaveBeenCalledOnce();
    expect(result.onResizeCommit).toHaveBeenCalledWith({ cols: 120, rows: 30 });
    expect(result.onFitted).toHaveBeenCalledWith({ cols: 120, rows: 30 });
  });

  it("preempts a slow checkpoint and follows every measurable drag update", () => {
    const { runFrames, scheduledFrames } = installFrameRunner();
    let cols = 80;
    const result = setup(() => ({ cols, rows: 24 }));
    initialize(result);

    cols = 82;
    result.scheduler.schedule();
    runFrames(1);
    expect(result.onFitted).toHaveBeenLastCalledWith({ cols: 82, rows: 24 });

    for (const next of [84, 88, 94, 100]) {
      cols = next;
      result.scheduler.schedule();
      runFrames(1);
    }
    expect(result.fit.fit).toHaveBeenCalledTimes(5);
    expect(result.onResizeStart).toHaveBeenCalledTimes(5);
    expect(result.onResizeCommit).toHaveBeenCalledTimes(5);
    expect(result.onFitted).toHaveBeenCalledTimes(5);
    expect(result.onFitted).toHaveBeenLastCalledWith({ cols: 100, rows: 24 });
    expect(scheduledFrames()).toBe(0);

    expect(result.scheduler.acknowledgeResize()).toBe(true);
    runFrames(2);
    expect(result.onResizeSettled).toHaveBeenCalledOnce();
  });

  it("immediately reverses before the old direction is acknowledged", () => {
    const { runFrames } = installFrameRunner();
    let cols = 80;
    const result = setup(() => ({ cols, rows: 24 }));
    initialize(result);

    cols = 130;
    result.scheduler.schedule();
    runFrames(1);
    cols = 80;
    result.scheduler.schedule();
    runFrames(1);

    expect(result.onFitted).toHaveBeenCalledTimes(2);
    expect(result.onFitted).toHaveBeenLastCalledWith({ cols: 80, rows: 24 });
    expect(result.scheduler.acknowledgeResize()).toBe(true);
    runFrames(2);
    expect(result.onResizeSettled).toHaveBeenCalledOnce();
  });

  it("ignores duplicate or stale checkpoint acknowledgements", () => {
    const { runFrames } = installFrameRunner();
    let cols = 80;
    const result = setup(() => ({ cols, rows: 24 }));
    initialize(result);

    cols = 100;
    result.scheduler.schedule();
    runFrames(1);

    expect(result.scheduler.acknowledgeResize()).toBe(true);
    expect(result.scheduler.acknowledgeResize()).toBe(false);
  });

  it("keeps the guard active until the acknowledged target is quiet", () => {
    const { runFrames } = installFrameRunner();
    let cols = 80;
    const result = setup(() => ({ cols, rows: 24 }));
    initialize(result);

    cols = 100;
    result.scheduler.schedule();
    runFrames(1);
    result.scheduler.acknowledgeResize();

    runFrames(1);
    expect(result.onResizeSettled).not.toHaveBeenCalled();
    runFrames(1);
    expect(result.onResizeSettled).toHaveBeenCalledOnce();
    expect(result.onResizeCancel).not.toHaveBeenCalled();
  });

  it("freezes output before a parser barrier and sends the latest measured grid", () => {
    const { runFrames } = installFrameRunner();
    let cols = 80;
    const result = setup(() => ({ cols, rows: 24 }));
    initialize(result);
    result.setPendingWrites(true);

    cols = 100;
    result.scheduler.schedule();
    runFrames(1);
    expect(result.onResizeStart).toHaveBeenCalledOnce();
    expect(result.queueWriteBarrier).toHaveBeenCalledOnce();
    expect(result.fit.fit).not.toHaveBeenCalled();

    cols = 120;
    result.scheduler.schedule();
    runFrames(1);
    result.drainBarrier();
    runFrames(1);

    expect(result.fit.fit).toHaveBeenCalledOnce();
    expect(result.onFitted).toHaveBeenCalledWith({ cols: 120, rows: 24 });
  });

  it("waits only for the parser barrier when preempting a frame already queued in xterm", () => {
    const { runFrames } = installFrameRunner();
    let cols = 80;
    const result = setup(() => ({ cols, rows: 24 }));
    initialize(result);

    cols = 100;
    result.scheduler.schedule();
    runFrames(1);
    expect(result.onFitted).toHaveBeenLastCalledWith({ cols: 100, rows: 24 });

    result.setPendingWrites(true);
    cols = 120;
    result.scheduler.schedule();
    runFrames(1);
    expect(result.queueWriteBarrier).toHaveBeenCalledOnce();
    expect(result.fit.fit).toHaveBeenCalledOnce();

    cols = 140;
    result.scheduler.schedule();
    runFrames(1);
    result.setPendingWrites(false);
    result.drainBarrier();
    runFrames(1);

    expect(result.fit.fit).toHaveBeenCalledTimes(2);
    expect(result.onFitted).toHaveBeenCalledTimes(2);
    expect(result.onFitted).toHaveBeenLastCalledWith({ cols: 140, rows: 24 });
  });

  it("cancels a prepared step that reverses before its parser barrier", () => {
    const { runFrames } = installFrameRunner();
    let cols = 80;
    const result = setup(() => ({ cols, rows: 24 }));
    initialize(result);
    result.setPendingWrites(true);

    cols = 100;
    result.scheduler.schedule();
    runFrames(1);
    cols = 80;
    result.scheduler.schedule();
    runFrames(1);
    result.drainBarrier();
    runFrames(1);

    expect(result.onResizeCancel).toHaveBeenCalledOnce();
    expect(result.onResizeCommit).not.toHaveBeenCalled();
    expect(result.onFitted).not.toHaveBeenCalled();
  });

  it("retries a transient fit failure without opening a second step", () => {
    const { runFrames } = installFrameRunner();
    let cols = 80;
    const result = setup(() => ({ cols, rows: 24 }));
    initialize(result);
    result.fit.fit.mockImplementationOnce(() => {
      throw new Error("renderer is being replaced");
    });

    cols = 100;
    result.scheduler.schedule();
    runFrames(1);
    expect(result.onResizeStart).toHaveBeenCalledOnce();
    expect(result.onFitted).not.toHaveBeenCalled();

    runFrames(1);
    expect(result.fit.fit).toHaveBeenCalledTimes(2);
    expect(result.onResizeStart).toHaveBeenCalledOnce();
    expect(result.onFitted).toHaveBeenCalledWith({ cols: 100, rows: 24 });
  });

  it("keeps a scrolled viewport anchored across each hidden fit", () => {
    const { runFrames } = installFrameRunner();
    let cols = 80;
    const terminal = makeTerminal(80, 24, 40, 100);
    const result = setup(() => ({ cols, rows: 24 }), terminal);
    initialize(result);
    result.fit.fit.mockImplementation(() => {
      terminal.cols = cols;
      terminal.buffer.active.viewportY = 0;
    });

    cols = 100;
    result.scheduler.schedule();
    runFrames(1);

    expect(terminal.scrollToLine).toHaveBeenCalledWith(40);
  });

  it("never queues more than one measurement frame", () => {
    const { scheduledFrames } = installFrameRunner();
    const result = setup(() => ({ cols: 100, rows: 24 }));

    for (let index = 0; index < 20; index += 1) result.scheduler.schedule();

    expect(scheduledFrames()).toBe(1);
  });

  it("does nothing after dispose", () => {
    const { runFrames } = installFrameRunner();
    const result = setup(() => ({ cols: 100, rows: 30 }));

    result.scheduler.dispose();
    result.scheduler.refitNow();
    result.scheduler.schedule();
    expect(result.scheduler.acknowledgeResize()).toBe(false);
    runFrames(10);

    expect(result.fit.fit).not.toHaveBeenCalled();
    expect(result.onFitted).not.toHaveBeenCalled();
  });
});
