import { afterEach, describe, expect, it, vi } from "vitest";

import { createViewportWatchdog } from "../src/lib/xtermViewportWatchdog";

function fakeTerminal(viewportY: number, baseY: number) {
  const buffer = { viewportY, baseY };
  const terminal = {
    buffer: { active: buffer },
    scrollToBottom: vi.fn(() => {
      buffer.viewportY = buffer.baseY;
    }),
  };
  return { terminal, buffer };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createViewportWatchdog", () => {
  it("reports atBottom from the buffer on the interval", () => {
    vi.useFakeTimers();
    const { terminal, buffer } = fakeTerminal(500, 500);
    const onAtBottom = vi.fn();
    const watchdog = createViewportWatchdog(terminal as never, onAtBottom, 1000);

    vi.advanceTimersByTime(1000);
    expect(onAtBottom).toHaveBeenCalledWith(true);

    buffer.viewportY = 120; // user scrolled up; no onScroll fired
    vi.advanceTimersByTime(1000);
    expect(onAtBottom).toHaveBeenLastCalledWith(false);

    watchdog.dispose();
  });

  it("never moves the viewport, even when not at the bottom", () => {
    vi.useFakeTimers();
    const { terminal, buffer } = fakeTerminal(120, 500);
    const watchdog = createViewportWatchdog(terminal as never, vi.fn(), 1000);

    vi.advanceTimersByTime(5000);
    expect(terminal.scrollToBottom).not.toHaveBeenCalled();
    expect(buffer.viewportY).toBe(120);

    watchdog.dispose();
  });

  it("manual check re-syncs immediately and keeps the schedule alive", () => {
    vi.useFakeTimers();
    const { terminal, buffer } = fakeTerminal(0, 800);
    const onAtBottom = vi.fn();
    const watchdog = createViewportWatchdog(terminal as never, onAtBottom, 1000);

    buffer.viewportY = 800;
    watchdog.check();
    expect(onAtBottom).toHaveBeenLastCalledWith(true);

    buffer.viewportY = 10;
    vi.advanceTimersByTime(1000); // interval still running after manual check
    expect(onAtBottom).toHaveBeenLastCalledWith(false);

    watchdog.dispose();
  });

  it("stops reporting after dispose", () => {
    vi.useFakeTimers();
    const { terminal } = fakeTerminal(0, 800);
    const onAtBottom = vi.fn();
    const watchdog = createViewportWatchdog(terminal as never, onAtBottom, 1000);

    watchdog.dispose();
    onAtBottom.mockClear();
    vi.advanceTimersByTime(5000);
    expect(onAtBottom).not.toHaveBeenCalled();
  });
});
