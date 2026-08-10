import { afterEach, describe, expect, it, vi } from "vitest";

import { OutputBatcher } from "../electron/main/services/output-batcher";

afterEach(() => {
  vi.useRealTimers();
});

function setup(options?: Parameters<typeof OutputBatcher.prototype.push> extends never ? never : object) {
  const flushed: Array<{ sessionPath: string; data: string }> = [];
  const onFlush = vi.fn((sessionPath: string, data: string) => {
    flushed.push({ sessionPath, data });
  });
  const batcher = new OutputBatcher(onFlush, options as never);
  return { batcher, onFlush, flushed };
}

describe("OutputBatcher", () => {
  it("flushes after flushMs, joining chunks in arrival order", () => {
    vi.useFakeTimers();
    const { batcher, onFlush } = setup();
    batcher.push("s1", "a");
    batcher.push("s1", "b");
    batcher.push("s1", "c");
    expect(onFlush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(8);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith("s1", "abc");
  });

  it("keeps sessions isolated", () => {
    vi.useFakeTimers();
    const { batcher, onFlush } = setup();
    batcher.push("s1", "a1");
    batcher.push("s2", "b1");
    batcher.push("s1", "a2");
    vi.advanceTimersByTime(8);
    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush).toHaveBeenCalledWith("s1", "a1a2");
    expect(onFlush).toHaveBeenCalledWith("s2", "b1");
  });

  it("flushes immediately when the size cap is reached", () => {
    vi.useFakeTimers();
    const { batcher, onFlush } = setup({ sizeCapBytes: 10 });
    batcher.push("s1", "12345");
    expect(onFlush).not.toHaveBeenCalled();
    batcher.push("s1", "67890"); // 10 bytes: cap reached
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith("s1", "1234567890");
    // The timer for the first chunk must not double-deliver.
    vi.advanceTimersByTime(100);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("flushes a complete synchronized TUI frame immediately", () => {
    vi.useFakeTimers();
    const { batcher, onFlush } = setup();
    batcher.push("s1", "\x1b[?2026hframe");
    expect(onFlush).not.toHaveBeenCalled();

    batcher.push("s1", "\x1b[?2026l");

    expect(onFlush).toHaveBeenCalledOnce();
    expect(onFlush).toHaveBeenCalledWith("s1", "\x1b[?2026hframe\x1b[?2026l");
    vi.advanceTimersByTime(100);
    expect(onFlush).toHaveBeenCalledOnce();
  });

  it("recognizes a synchronized frame close split across PTY chunks", () => {
    vi.useFakeTimers();
    const { batcher, onFlush } = setup();
    batcher.push("s1", "frame\x1b[?20");
    batcher.push("s1", "26");
    expect(onFlush).not.toHaveBeenCalled();

    batcher.push("s1", "l");

    expect(onFlush).toHaveBeenCalledOnce();
    expect(onFlush).toHaveBeenCalledWith("s1", "frame\x1b[?2026l");
  });

  it("keeps synchronized frames on the stock timer when the optimization is disabled", () => {
    vi.useFakeTimers();
    const { batcher, onFlush } = setup({ flushSynchronizedFrames: () => false });
    batcher.push("s1", "frame\x1b[?2026l");
    expect(onFlush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(8);
    expect(onFlush).toHaveBeenCalledWith("s1", "frame\x1b[?2026l");
  });

  it("restarts a fresh timer after an early flush", () => {
    vi.useFakeTimers();
    const { batcher, onFlush } = setup();
    batcher.push("s1", "a");
    batcher.flush("s1");
    expect(onFlush).toHaveBeenCalledWith("s1", "a");
    batcher.push("s1", "b");
    vi.advanceTimersByTime(8);
    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush).toHaveBeenLastCalledWith("s1", "b");
  });

  it("forwards a single-chunk batch without joining (same string reference)", () => {
    vi.useFakeTimers();
    const { batcher, flushed } = setup();
    const chunk = "single";
    batcher.push("s1", chunk);
    vi.advanceTimersByTime(8);
    expect(flushed).toHaveLength(1);
    expect(flushed[0].data).toBe(chunk);
  });

  it("manual flush delivers immediately and clears the pending timer", () => {
    vi.useFakeTimers();
    const { batcher, onFlush } = setup();
    batcher.push("s1", "a");
    batcher.flush("s1");
    expect(onFlush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(onFlush).toHaveBeenCalledTimes(1);
    // Flushing an empty batch is a no-op.
    batcher.flush("s1");
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("dispose cancels timers and drops undelivered data", () => {
    vi.useFakeTimers();
    const { batcher, onFlush } = setup();
    batcher.push("s1", "a");
    batcher.dispose();
    vi.advanceTimersByTime(100);
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("ignores empty chunks", () => {
    vi.useFakeTimers();
    const { batcher, onFlush } = setup();
    batcher.push("s1", "");
    vi.advanceTimersByTime(100);
    expect(onFlush).not.toHaveBeenCalled();
  });
});
