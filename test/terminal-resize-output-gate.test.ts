import { describe, expect, it, vi } from "vitest";

import { createTerminalResizeOutputGate } from "../src/lib/terminalResizeOutputGate";
import { encodeResizeFrameMarker, FULLSCREEN_REDRAW_PREFIX } from "../src/lib/terminalResizeProtocol";

const SYNC_OPEN = "\x1b[?2026h";
const SYNC_CLOSE = "\x1b[?2026l";
const FULL_REDRAW = "\x1b[2J\x1b[H\x1b[3J";
const ALT_SCREEN_REPLAY_PROLOGUE =
  "\x1b[?1049h\x1b[?7l\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h\x1b[?25l";

function frame(content: string): string {
  return `${SYNC_OPEN}${FULL_REDRAW}${content}${SYNC_CLOSE}`;
}

function taggedFrame(cols: number, rows: number, content: string): string {
  return `${FULLSCREEN_REDRAW_PREFIX}${encodeResizeFrameMarker({ cols, rows })}${content}${SYNC_CLOSE}`;
}

function createWriteHarness() {
  const writes: Array<{ data: string; onWritten?: () => void }> = [];
  const write = vi.fn((data: string, onWritten?: () => void) => {
    writes.push({ data, onWritten });
  });
  return { write, writes };
}

describe("createTerminalResizeOutputGate", () => {
  it("passes output through while idle", () => {
    const { write } = createWriteHarness();
    const gate = createTerminalResizeOutputGate({ write });

    gate.push("live");

    expect(write).toHaveBeenCalledWith("live");
  });

  it("buffers output during local reflow and flushes it when the grid returns", () => {
    const { write } = createWriteHarness();
    const gate = createTerminalResizeOutputGate({ write });

    gate.begin();
    gate.push("one");
    gate.push("two");

    expect(write).not.toHaveBeenCalled();
    expect(gate.cancel()).toBe("flushed");
    expect(write).toHaveBeenCalledWith("onetwo");
  });

  it("streams an authoritative frame but recovers only after its close parses", () => {
    const { write, writes } = createWriteHarness();
    const recovered = vi.fn();
    const gate = createTerminalResizeOutputGate({ write, onCheckpointRecovered: recovered });

    gate.begin();
    gate.push("old-size incremental output");
    gate.commit();
    gate.push(`${SYNC_OPEN}${FULL_REDRAW}new-size`);

    expect(writes.map(({ data }) => data).join("")).toBe(`${SYNC_OPEN}${FULL_REDRAW}new-size`);
    expect(recovered).not.toHaveBeenCalled();
    expect(gate.isActive()).toBe(true);

    gate.push(SYNC_CLOSE);
    expect(writes.map(({ data }) => data).join("")).toBe(frame("new-size"));
    expect(recovered).not.toHaveBeenCalled();

    writes.at(-1)?.onWritten?.();
    expect(recovered).toHaveBeenCalledOnce();
    expect(gate.isActive()).toBe(false);
  });

  it("recognizes a redraw marker split across IPC chunks", () => {
    const { writes } = createWriteHarness();
    const gate = createTerminalResizeOutputGate({ write: (data, onWritten) => writes.push({ data, onWritten }) });

    gate.begin();
    gate.commit();
    gate.push(`${SYNC_OPEN}${FULL_REDRAW.slice(0, 6)}`);
    expect(writes).toHaveLength(0);

    gate.push(`${FULL_REDRAW.slice(6)}split${SYNC_CLOSE}`);
    expect(writes.map(({ data }) => data).join("")).toBe(frame("split"));
  });

  it("recognizes a checkpoint close split across IPC chunks", () => {
    const { write, writes } = createWriteHarness();
    const recovered = vi.fn();
    const gate = createTerminalResizeOutputGate({ write, onCheckpointRecovered: recovered });

    gate.begin();
    gate.commit();
    gate.push(`${SYNC_OPEN}${FULL_REDRAW}split-close${SYNC_CLOSE.slice(0, -2)}`);
    expect(writes.at(-1)?.onWritten).toBeUndefined();

    gate.push(SYNC_CLOSE.slice(-2));
    expect(writes.at(-1)?.onWritten).toBeTypeOf("function");
    expect(recovered).not.toHaveBeenCalled();

    writes.at(-1)?.onWritten?.();
    expect(recovered).toHaveBeenCalledOnce();
  });

  it("rejects a late tagged frame from the wrong grid before writing any of it", () => {
    const { write, writes } = createWriteHarness();
    const rejected = vi.fn();
    const recovered = vi.fn();
    const gate = createTerminalResizeOutputGate({
      write,
      onCheckpointRejected: rejected,
      onCheckpointRecovered: recovered,
    });

    gate.begin();
    gate.commit({ expectedSize: { cols: 120, rows: 30 } });
    gate.push(taggedFrame(80, 24, "stale"));

    expect(writes).toHaveLength(0);
    expect(rejected).toHaveBeenCalledWith({ cols: 80, rows: 24 }, { cols: 120, rows: 30 });
    expect(gate.isActive()).toBe(true);

    gate.push(taggedFrame(120, 30, "latest"));
    expect(writes.map(({ data }) => data).join("")).toBe(ALT_SCREEN_REPLAY_PROLOGUE + taggedFrame(120, 30, "latest"));
    writes.at(-1)?.onWritten?.();
    expect(recovered).toHaveBeenCalledOnce();
  });

  it("rejects an untagged frame when the resize requires an exact grid", () => {
    const { write, writes } = createWriteHarness();
    const rejected = vi.fn();
    const recovered = vi.fn();
    const gate = createTerminalResizeOutputGate({
      write,
      onCheckpointRejected: rejected,
      onCheckpointRecovered: recovered,
    });

    gate.begin();
    gate.commit({ expectedSize: { cols: 120, rows: 30 } });
    gate.push(frame("unknown-grid"));

    expect(writes).toHaveLength(0);
    expect(rejected).toHaveBeenCalledWith(undefined, { cols: 120, rows: 30 });

    gate.push(taggedFrame(120, 30, "latest"));
    writes.at(-1)?.onWritten?.();
    expect(recovered).toHaveBeenCalledOnce();
  });

  it("waits for resize metadata split across IPC chunks before streaming", () => {
    const { writes } = createWriteHarness();
    const gate = createTerminalResizeOutputGate({ write: (data, onWritten) => writes.push({ data, onWritten }) });
    const checkpoint = taggedFrame(100, 28, "complete");
    const splitAt = FULLSCREEN_REDRAW_PREFIX.length + 8;

    gate.begin();
    gate.commit({ expectedSize: { cols: 100, rows: 28 } });
    gate.push(checkpoint.slice(0, splitAt));
    expect(writes).toHaveLength(0);

    gate.push(checkpoint.slice(splitAt));
    expect(writes.map(({ data }) => data).join("")).toBe(ALT_SCREEN_REPLAY_PROLOGUE + checkpoint);
  });

  it("ignores an older checkpoint callback after a newer resize begins", () => {
    const { write, writes } = createWriteHarness();
    const recovered = vi.fn();
    const gate = createTerminalResizeOutputGate({ write, onCheckpointRecovered: recovered });

    gate.begin();
    gate.commit();
    gate.push(frame("stale"));
    const staleCallback = writes.at(-1)?.onWritten;

    gate.begin();
    gate.commit();
    gate.push(frame("latest"));
    const latestCallback = writes.at(-1)?.onWritten;

    expect(writes.map(({ data }) => data).join("")).toBe(frame("stale") + frame("latest"));
    staleCallback?.();
    expect(recovered).not.toHaveBeenCalled();
    expect(gate.isActive()).toBe(true);

    latestCallback?.();
    expect(recovered).toHaveBeenCalledOnce();
    expect(gate.isActive()).toBe(false);
  });

  it("streams a hidden shimmy frame, then waits for the final frame", () => {
    const { write, writes } = createWriteHarness();
    const skipped = vi.fn();
    const recovered = vi.fn();
    const gate = createTerminalResizeOutputGate({
      write,
      onCheckpointRecovered: recovered,
      onCheckpointSkipped: skipped,
    });

    gate.begin();
    gate.commit({ skipCompleteFrames: 1 });
    gate.push(frame("rows-plus-one"));
    expect(writes.map(({ data }) => data).join("")).toBe(frame("rows-plus-one"));
    expect(skipped).not.toHaveBeenCalled();

    writes.at(-1)?.onWritten?.();
    expect(skipped).toHaveBeenCalledOnce();
    expect(recovered).not.toHaveBeenCalled();
    expect(gate.isActive()).toBe(true);

    gate.push(frame("final-rows"));
    expect(writes.map(({ data }) => data).join("")).toBe(frame("rows-plus-one") + frame("final-rows"));
    writes.at(-1)?.onWritten?.();
    expect(recovered).toHaveBeenCalledOnce();
    expect(gate.isActive()).toBe(false);
  });

  it("streams a multi-megabyte checkpoint without overflowing", () => {
    const { write, writes } = createWriteHarness();
    const recovered = vi.fn();
    const gate = createTerminalResizeOutputGate({ write, onCheckpointRecovered: recovered });
    const authoritativeFrame = frame("x".repeat(2_500_000));
    const chunkSize = 64 * 1024;

    gate.begin();
    gate.commit();
    for (let offset = 0; offset < authoritativeFrame.length; offset += chunkSize) {
      gate.push(authoritativeFrame.slice(offset, offset + chunkSize));
    }

    expect(writes.length).toBeGreaterThan(30);
    expect(writes.reduce((length, { data }) => length + data.length, 0)).toBe(authoritativeFrame.length);
    expect(recovered).not.toHaveBeenCalled();
    expect(gate.isActive()).toBe(true);

    writes.at(-1)?.onWritten?.();
    expect(recovered).toHaveBeenCalledOnce();
    expect(gate.isActive()).toBe(false);
  });

  it("requires a checkpoint if held old-size output overflowed", () => {
    const { write } = createWriteHarness();
    const gate = createTerminalResizeOutputGate({ write });

    gate.begin();
    gate.push("x".repeat(400_001));

    expect(gate.cancel()).toBe("needs-checkpoint");
    expect(write).not.toHaveBeenCalled();
    expect(gate.isActive()).toBe(true);
  });

  it("drops held output and stale callbacks after dispose", () => {
    const { write, writes } = createWriteHarness();
    const recovered = vi.fn();
    const gate = createTerminalResizeOutputGate({ write, onCheckpointRecovered: recovered });

    gate.begin();
    gate.commit();
    gate.push(frame("pending"));
    const pendingCallback = writes.at(-1)?.onWritten;
    gate.dispose();
    gate.push("ignored");
    pendingCallback?.();

    expect(write).toHaveBeenCalledOnce();
    expect(recovered).not.toHaveBeenCalled();
    expect(gate.isActive()).toBe(false);
  });
});
