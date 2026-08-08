import { afterEach, describe, expect, it } from "vitest";

import {
  appendTerminalBuffer,
  clearTerminalBuffer,
  getReplayContent,
  isAwaitingCheckpoint,
  setMaxBufferedSessions,
} from "../src/lib/terminalReplayStore";

const SYNC_OPEN = "\x1b[?2026h";
const SYNC_CLOSE = "\x1b[?2026l";
const FULL_REDRAW = "\x1b[2J\x1b[H\x1b[3J";

function frame(n: number): string {
  return `${SYNC_OPEN}${FULL_REDRAW}frame ${n}\r\n${SYNC_CLOSE}`;
}

afterEach(() => {
  setMaxBufferedSessions(6);
  clearTerminalBuffer("__eviction__");
});

describe("terminal replay store (LRU eviction)", () => {
  it("evicts the least recently used sessions beyond the cap", () => {
    setMaxBufferedSessions(3);
    appendTerminalBuffer("s1", frame(1));
    appendTerminalBuffer("s2", frame(2));
    appendTerminalBuffer("s3", frame(3));
    appendTerminalBuffer("s4", frame(4)); // evicts s1

    expect(getReplayContent("s1")).toBe("");
    expect(getReplayContent("s2")).toContain("frame 2");
    expect(getReplayContent("s3")).toContain("frame 3");
    expect(getReplayContent("s4")).toContain("frame 4");
  });

  it("re-touching a session makes it most recently used (not evicted)", () => {
    setMaxBufferedSessions(3);
    appendTerminalBuffer("s1", frame(1));
    appendTerminalBuffer("s2", frame(2));
    appendTerminalBuffer("s3", frame(3));
    appendTerminalBuffer("s1", frame(1)); // s1 is now MRU
    appendTerminalBuffer("s4", frame(4)); // evicts s2, not s1

    expect(getReplayContent("s1")).toContain("frame 1");
    expect(getReplayContent("s2")).toBe("");
    expect(getReplayContent("s3")).toContain("frame 3");
    expect(getReplayContent("s4")).toContain("frame 4");
  });

  it("the session being written right now is never evicted", () => {
    setMaxBufferedSessions(1);
    appendTerminalBuffer("s1", frame(1));
    appendTerminalBuffer("s2", frame(2)); // evicts s1
    // Writing s2 again re-inserts it as MRU; the loop must not evict it.
    appendTerminalBuffer("s2", frame(2));
    expect(getReplayContent("s2")).toContain("frame 2");
    expect(getReplayContent("s1")).toBe("");
  });

  it("clearTerminalBuffer removes a session entirely", () => {
    appendTerminalBuffer("s1", frame(1));
    expect(getReplayContent("s1")).toContain("frame 1");
    clearTerminalBuffer("s1");
    expect(getReplayContent("s1")).toBe("");
    expect(isAwaitingCheckpoint("s1")).toBe(false);
  });

  it("evicted sessions report awaitingCheckpoint=false (empty replay)", () => {
    setMaxBufferedSessions(1);
    appendTerminalBuffer("s1", frame(1));
    appendTerminalBuffer("s2", frame(2));
    expect(getReplayContent("s1")).toBe("");
    expect(isAwaitingCheckpoint("s1")).toBe(false);
  });
});
