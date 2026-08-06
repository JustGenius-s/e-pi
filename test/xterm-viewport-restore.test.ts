import { afterEach, describe, expect, it, vi } from "vitest";

import { restoreViewportAfterSettle } from "../src/lib/xtermViewportRestore";
import type { ViewportRestoreOptions } from "../src/lib/xtermViewportRestore";

interface FakeBuffer {
  viewportY: number;
  baseY: number;
}

function fakeTerminal(viewportY: number, baseY: number) {
  const buffer: FakeBuffer = { viewportY, baseY };
  const terminal = {
    buffer: { active: buffer },
    scrollToBottom: vi.fn(() => {
      buffer.viewportY = buffer.baseY;
    }),
    scrollToLine: vi.fn((line: number) => {
      buffer.viewportY = line;
    }),
  };
  return { terminal, buffer };
}

type FrameCallback = () => void;

function installFrameRunner() {
  let queue: FrameCallback[] = [];
  let nextId = 1;
  const raf = vi.fn((callback: FrameCallback) => queue.push(callback) || nextId++);
  vi.stubGlobal("requestAnimationFrame", raf);
  return {
    raf,
    /** Run exactly `count` frames; callbacks scheduled during a frame run in the same frame. */
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

function restore(
  options: Omit<ViewportRestoreOptions, "terminal" | "isStale"> & {
    viewportY: number;
    baseY: number;
    isStale?: () => boolean;
  },
) {
  const { terminal, buffer } = fakeTerminal(options.viewportY, options.baseY);
  restoreViewportAfterSettle({
    terminal: terminal as never,
    wasAtBottom: options.wasAtBottom,
    topLine: options.topLine,
    isStale: options.isStale ?? (() => false),
  });
  return { terminal, buffer };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("restoreViewportAfterSettle", () => {
  it("restores the captured line after xterm's late viewport sync settles", () => {
    const { raf, runFrames } = installFrameRunner();
    // Refit clamped the viewport to 0; xterm's own sync lands on frame 1.
    const { terminal, buffer } = restore({ viewportY: 0, baseY: 800, wasAtBottom: false, topLine: 320 });

    expect(raf).toHaveBeenCalledTimes(1); // first settle-check frame scheduled

    buffer.viewportY = 120; // xterm's queued viewport sync runs
    runFrames(1); // frame 1: viewport moved -> not stable yet

    runFrames(2); // frames 2-3: stable -> restore
    expect(terminal.scrollToLine).toHaveBeenCalledTimes(1);
    expect(terminal.scrollToLine).toHaveBeenCalledWith(320);
    expect(buffer.viewportY).toBe(320);

    runFrames(1); // straggler guard frame: already correct -> no second call
    expect(terminal.scrollToLine).toHaveBeenCalledTimes(1);
  });

  it("restores the bottom when the viewport was following output", () => {
    const { runFrames } = installFrameRunner();
    const { terminal, buffer } = restore({ viewportY: 600, baseY: 600, wasAtBottom: true, topLine: 600 });

    runFrames(3); // 2 settle frames + restore
    expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1);
    expect(buffer.viewportY).toBe(600);

    runFrames(1); // straggler: still at bottom -> no second call
    expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("corrects a straggler sync that clamps the viewport after the restore", () => {
    const { runFrames } = installFrameRunner();
    const { terminal, buffer } = restore({ viewportY: 0, baseY: 800, wasAtBottom: false, topLine: 320 });

    buffer.viewportY = 120; // xterm's queued viewport sync runs on frame 1
    runFrames(3); // moved, then 2 stable frames -> restore to 320
    expect(buffer.viewportY).toBe(320);

    buffer.viewportY = 0; // straggler sync clamps back to the top
    runFrames(1); // the straggler guard frame corrects it
    expect(terminal.scrollToLine).toHaveBeenCalledTimes(2);
    expect(buffer.viewportY).toBe(320);
  });

  it("keeps the viewport when it already sits at the captured line", () => {
    const { runFrames } = installFrameRunner();
    const { terminal } = restore({ viewportY: 320, baseY: 800, wasAtBottom: false, topLine: 320 });

    runFrames(3);
    expect(terminal.scrollToLine).not.toHaveBeenCalled();
    expect(terminal.scrollToBottom).not.toHaveBeenCalled();
  });

  it("aborts immediately when the restore becomes stale", () => {
    const { runFrames } = installFrameRunner();
    let stale = false;
    const { terminal } = restore({ viewportY: 0, baseY: 800, wasAtBottom: false, topLine: 320, isStale: () => stale });

    stale = true; // terminal disposed or a newer refit started
    runFrames(10);
    expect(terminal.scrollToLine).not.toHaveBeenCalled();
    expect(terminal.scrollToBottom).not.toHaveBeenCalled();
  });

  it("gives up after the frame bound and restores anyway", () => {
    const { runFrames } = installFrameRunner();
    const { terminal, buffer } = restore({ viewportY: 0, baseY: 800, wasAtBottom: false, topLine: 320 });

    // xterm keeps re-syncing every frame, so the viewport never settles.
    for (let i = 0; i < 59; i += 1) {
      buffer.viewportY = i % 2 === 0 ? 100 : 200; // never stable
      runFrames(1);
    }
    buffer.viewportY = 300; // frame 60: the bound hits and restore runs regardless
    runFrames(1);
    expect(terminal.scrollToLine).toHaveBeenCalledTimes(1);
    expect(terminal.scrollToLine).toHaveBeenCalledWith(320);

    runFrames(1); // straggler: already at the line -> no second call
    expect(terminal.scrollToLine).toHaveBeenCalledTimes(1);
  });
});
