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
  refresh: ReturnType<typeof vi.fn>;
  scrollToBottom: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  onFitted: ReturnType<typeof vi.fn>;
}

function makeTerminal(cols = 80, rows = 24, viewportY = 0, baseY = 0): FakeTerminal {
  const buffer: FakeBuffer = { viewportY, baseY };
  return {
    cols,
    rows,
    buffer: { active: buffer },
    refresh: vi.fn(),
    scrollToBottom: vi.fn(() => {
      buffer.viewportY = buffer.baseY;
    }),
    write: vi.fn((_data: string, cb?: () => void) => cb?.()),
    onFitted: vi.fn(),
  };
}

function makeFit(terminal: FakeTerminal, proposed: () => { cols: number; rows: number }) {
  return {
    proposeDimensions: vi.fn(proposed),
    fit: vi.fn(() => {
      const dims = proposed();
      terminal.cols = dims.cols;
      terminal.rows = dims.rows;
    }),
  };
}

type FrameCallback = () => void;

function installFrameRunner() {
  let queue: FrameCallback[] = [];
  let nextId = 1;
  const raf = vi.fn((callback: FrameCallback) => queue.push(callback) || nextId++);
  vi.stubGlobal("requestAnimationFrame", raf);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  return {
    raf,
    runFrames(count: number) {
      for (let i = 0; i < count; i += 1) {
        const pending = queue;
        queue = [];
        for (const callback of pending) callback();
      }
    },
    scheduledFrames() {
      return queue.length;
    },
  };
}

function setup(proposed: () => { cols: number; rows: number }) {
  const terminal = makeTerminal(80, 24);
  const fit = makeFit(terminal, proposed);
  const onFitted = vi.fn();
  const scheduler = createResizeScheduler({
    terminal: terminal as never,
    fit: fit as never,
    hasPendingWrites: () => false,
    queueWriteBarrier: (onDrained) => onDrained(),
    onFitted: onFitted as never,
  });
  return { terminal, fit, onFitted, scheduler };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createResizeScheduler", () => {
  it("refits immediately on refitNow when the grid changed", () => {
    installFrameRunner();
    const { terminal, fit, onFitted, scheduler } = setup(() => ({ cols: 100, rows: 30 }));
    scheduler.refitNow();
    expect(fit.fit).toHaveBeenCalledTimes(1);
    expect(terminal.cols).toBe(100);
    expect(onFitted).toHaveBeenCalledWith({ cols: 100, rows: 30 });
  });

  it("skips the fit when the grid did not change", () => {
    installFrameRunner();
    const { fit, onFitted, scheduler } = setup(() => ({ cols: 80, rows: 24 }));
    scheduler.refitNow();
    expect(fit.fit).not.toHaveBeenCalled();
    expect(onFitted).not.toHaveBeenCalled();
  });

  it("refits once after the size is stable for one frame", () => {
    const { runFrames } = installFrameRunner();
    vi.spyOn(performance, "now").mockReturnValue(0);
    let proposed = { cols: 80, rows: 24 };
    const { terminal, onFitted, scheduler } = setup(() => proposed);

    scheduler.schedule();
    // Frame 1: size changed -> local reflow only (no PTY resize yet).
    proposed = { cols: 120, rows: 30 };
    runFrames(1);
    expect(onFitted).not.toHaveBeenCalled();

    // Frame 2: stable -> final refit with PTY resize.
    runFrames(1);
    expect(onFitted).toHaveBeenCalledTimes(1);
    expect(onFitted).toHaveBeenCalledWith({ cols: 120, rows: 30 });
    expect(terminal.cols).toBe(120);

    // Settled: the loop stopped (remaining rAFs are viewport restore's own).
    runFrames(5);
    expect(onFitted).toHaveBeenCalledTimes(1);
  });

  it("refits on the first frame when the change already happened before scheduling", () => {
    const { runFrames } = installFrameRunner();
    vi.spyOn(performance, "now").mockReturnValue(0);
    const { onFitted, scheduler } = setup(() => ({ cols: 90, rows: 24 }));

    scheduler.schedule();
    // Frame 1: proposes the new size (differs from terminal 80x24) -> local
    // reflow. Frame 2: stable -> final refit with PTY resize.
    runFrames(3);
    expect(onFitted).toHaveBeenCalledTimes(1);
  });

  it("sends no PTY resize within the drag interval while the size keeps changing", () => {
    const { runFrames } = installFrameRunner();
    vi.spyOn(performance, "now").mockReturnValue(0);
    let width = 80;
    const { fit, onFitted, scheduler } = setup(() => ({ cols: width, rows: 24 }));

    scheduler.schedule();
    for (let i = 0; i < 20; i += 1) {
      width += 2; // changes every frame, like a drag
      runFrames(1);
    }
    // Local reflows happened every frame, but no PTY resize within 120ms.
    expect(fit.fit).toHaveBeenCalledTimes(20);
    expect(onFitted).not.toHaveBeenCalled();

    width += 2;
    runFrames(1); // changed again
    runFrames(2); // stable now -> final refit
    expect(onFitted).toHaveBeenCalledTimes(1);
  });

  it("waits on the write barrier but refits anyway after the cap", () => {
    const { runFrames } = installFrameRunner();
    const terminal = makeTerminal(80, 24);
    const fit = makeFit(terminal, () => ({ cols: 110, rows: 30 }));
    const onFitted = vi.fn();
    let drained: (() => void) | undefined;
    const queueWriteBarrier = vi.fn((cb: () => void) => {
      drained = cb;
    });
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);

    const scheduler = createResizeScheduler({
      terminal: terminal as never,
      fit: fit as never,
      hasPendingWrites: () => true, // a sustained stream never drains
      queueWriteBarrier,
      onFitted: onFitted as never,
    });

    scheduler.refitNow();
    expect(queueWriteBarrier).toHaveBeenCalledTimes(1);
    expect(fit.fit).not.toHaveBeenCalled();

    // Within the cap (100ms): still deferred even after many frames.
    now = 50;
    runFrames(10);
    expect(fit.fit).not.toHaveBeenCalled();

    // Past the cap: the next refit attempt proceeds despite pending writes.
    now = 150;
    scheduler.refitNow();
    expect(fit.fit).toHaveBeenCalledTimes(1);
    expect(onFitted).toHaveBeenCalledWith({ cols: 110, rows: 30 });

    // A late barrier drain must not double-fit (deferredRefit cleared).
    drained?.();
    expect(fit.fit).toHaveBeenCalledTimes(1);
  });

  it("refits when the barrier drains before the cap", () => {
    installFrameRunner();
    const terminal = makeTerminal(80, 24);
    const fit = makeFit(terminal, () => ({ cols: 110, rows: 30 }));
    const onFitted = vi.fn();
    let drained: (() => void) | undefined;
    const queueWriteBarrier = vi.fn((cb: () => void) => {
      drained = cb;
    });
    let pending = true;
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);

    const scheduler = createResizeScheduler({
      terminal: terminal as never,
      fit: fit as never,
      hasPendingWrites: () => pending,
      queueWriteBarrier,
      onFitted: onFitted as never,
    });

    scheduler.refitNow();
    expect(fit.fit).not.toHaveBeenCalled();

    pending = false; // parser drained
    now = 20;
    drained?.();
    expect(fit.fit).toHaveBeenCalledTimes(1);
    expect(onFitted).toHaveBeenCalledWith({ cols: 110, rows: 30 });
  });

  it("repaints the current screen on the first settle frame", () => {
    const { runFrames } = installFrameRunner();
    const { terminal, scheduler } = setup(() => ({ cols: 80, rows: 24 }));

    scheduler.schedule();
    runFrames(1);
    expect(terminal.refresh).toHaveBeenCalledWith(0, 23);
  });

  it("does nothing after dispose", () => {
    const { runFrames } = installFrameRunner();
    const { fit, scheduler } = setup(() => ({ cols: 100, rows: 30 }));

    scheduler.dispose();
    scheduler.refitNow();
    scheduler.schedule();
    runFrames(10);
    expect(fit.fit).not.toHaveBeenCalled();
  });
});

it("reflows locally every frame and sends PTY resizes at a throttled rate (drag follow)", () => {
  const { runFrames } = installFrameRunner();
  let width = 80;
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const { fit, onFitted, scheduler } = setup(() => ({ cols: width, rows: 24 }));

  scheduler.schedule();
  // Drag: the grid changes every frame; time advances ~16ms per frame.
  for (let i = 0; i < 10; i += 1) {
    width += 2;
    now += 16;
    runFrames(1);
  }
  // Local reflow every frame; the 10th frame (160ms) also hits the 120ms
  // throttle -> one PTY resize so far, 11 fit calls (10 local + 1 throttled).
  expect(fit.fit).toHaveBeenCalledTimes(11);
  expect(onFitted).toHaveBeenCalledTimes(1);

  // Keep dragging past another interval -> a second PTY resize.
  for (let i = 0; i < 8; i += 1) {
    width += 2;
    now += 16;
    runFrames(1);
  }
  expect(onFitted).toHaveBeenCalledTimes(2);

  // Release: one stable frame settles -> final PTY resize.
  for (let i = 0; i < 3; i += 1) {
    now += 16;
    runFrames(1);
  }
  expect(onFitted).toHaveBeenCalledTimes(3);
});

it("skips local reflow only while a large frame is draining", () => {
  const { runFrames } = installFrameRunner();
  vi.spyOn(performance, "now").mockReturnValue(0);
  let width = 80;
  let pendingBytes = 0;
  const terminal = makeTerminal(80, 24);
  const fit2 = makeFit(terminal, () => ({ cols: width, rows: 24 }));
  const onFitted2 = vi.fn();
  const s2 = createResizeScheduler({
    terminal: terminal as never,
    fit: fit2 as never,
    hasPendingWrites: () => pendingBytes > 0,
    pendingWriteBytes: () => pendingBytes,
    queueWriteBarrier: (cb) => cb(),
    onFitted: onFitted2 as never,
  });
  s2.schedule();
  width += 2;

  // Small incremental update (spinner tick): must NOT block local reflow —
  // otherwise a one-shot panel toggle leaves the canvas unexpanded.
  pendingBytes = 512;
  runFrames(1);
  expect(fit2.fit).toHaveBeenCalledTimes(1);

  // Large frame draining: local reflow pauses.
  pendingBytes = 32 * 1024;
  width += 2;
  runFrames(1);
  expect(fit2.fit).toHaveBeenCalledTimes(1);

  // Frame drained: local reflow resumes.
  pendingBytes = 0;
  width += 2;
  runFrames(1);
  expect(fit2.fit).toHaveBeenCalledTimes(2);
});
