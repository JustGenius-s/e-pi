import { afterEach, describe, expect, it } from "vitest";

import {
  appendTerminalBuffer,
  clearAllTerminalBuffers,
  clearTerminalBuffer,
  consumeTerminalModeReset,
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

  it("evicted sessions still report awaitingCheckpoint (remount must force a redraw)", () => {
    setMaxBufferedSessions(1);
    appendTerminalBuffer("s1", frame(1));
    appendTerminalBuffer("s2", frame(2));
    expect(getReplayContent("s1")).toBe("");
    // The whole point: the shimmy branch in TerminalPanel keys off this flag,
    // otherwise switching back to s1 would leave a blank terminal.
    expect(isAwaitingCheckpoint("s1")).toBe(true);
    expect(isAwaitingCheckpoint("s2")).toBe(false);
  });

  it("new output for an evicted session clears the eviction marker", () => {
    setMaxBufferedSessions(1);
    appendTerminalBuffer("s1", frame(1));
    appendTerminalBuffer("s2", frame(2)); // evicts s1
    expect(isAwaitingCheckpoint("s1")).toBe(true);
    // A live chunk arrives (feeder) — the session resumes in checkpoint-waiting
    // state: its stream is incomplete, so nothing replays until a full redraw.
    appendTerminalBuffer("s1", "more output");
    expect(isAwaitingCheckpoint("s1")).toBe(true);
    expect(getReplayContent("s1")).toBe("");
    // A full redraw arrives: recovered, marker cleared.
    appendTerminalBuffer("s1", frame(3));
    expect(isAwaitingCheckpoint("s1")).toBe(false);
    expect(getReplayContent("s1")).toContain("frame 3");
  });

  it("clearTerminalBuffer also clears the eviction marker", () => {
    setMaxBufferedSessions(1);
    appendTerminalBuffer("s1", frame(1));
    appendTerminalBuffer("s2", frame(2)); // evicts s1
    expect(isAwaitingCheckpoint("s1")).toBe(true);
    clearTerminalBuffer("s1");
    expect(isAwaitingCheckpoint("s1")).toBe(false);
    expect(getReplayContent("s1")).toBe("");
  });

  it("marks mode-reset sessions for one forced fresh frame without reusing their replay", () => {
    appendTerminalBuffer("mode-reset", frame(1));

    clearAllTerminalBuffers();

    expect(getReplayContent("mode-reset")).toBe("");
    expect(isAwaitingCheckpoint("mode-reset")).toBe(true);
    expect(consumeTerminalModeReset("mode-reset")).toBe(true);
    expect(consumeTerminalModeReset("mode-reset")).toBe(false);
    clearTerminalBuffer("mode-reset");
  });

  it("eviction markers are bounded (FIFO, oldest forgotten first)", () => {
    setMaxBufferedSessions(1);
    // Each new session evicts the previous one; 14 sessions -> 13 evictions,
    // but the marker map is capped, so the very first evictions are forgotten.
    for (let i = 1; i <= 14; i += 1) {
      appendTerminalBuffer(`s${i}`, frame(i));
    }
    expect(getReplayContent("s14")).toContain("frame 14");
    // The most recent eviction is still marked...
    expect(isAwaitingCheckpoint("s13")).toBe(true);
    // ...but markers beyond the cap were dropped (s1 evicted 13 sessions ago).
    expect(isAwaitingCheckpoint("s1")).toBe(false);
    expect(isAwaitingCheckpoint("s2")).toBe(true);
    expect(isAwaitingCheckpoint("s13")).toBe(true);
  });
});
