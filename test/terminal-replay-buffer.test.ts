import { describe, expect, it } from "vitest";

import { appendTerminalReplay } from "../src/lib/terminalReplayBuffer";
import type { TerminalReplayBuffer } from "../src/lib/terminalReplayBuffer";

const SYNC_OPEN = "\x1b[?2026h";
const SYNC_CLOSE = "\x1b[?2026l";
const FULL_REDRAW = "\x1b[2J\x1b[H\x1b[3J";

function append(current: TerminalReplayBuffer | undefined, data: string, maxChars = 100): TerminalReplayBuffer {
  return appendTerminalReplay(current, data, maxChars);
}

describe("terminal replay buffer", () => {
  it("keeps ordinary incremental output", () => {
    const first = append(undefined, "first");
    expect(append(first, " second").content).toBe("first second");
  });

  it("checkpoints at the latest authoritative TUI redraw", () => {
    const firstFrame = `${SYNC_OPEN}${FULL_REDRAW}old${SYNC_CLOSE}`;
    const latestFrame = `${SYNC_OPEN}${FULL_REDRAW}tool result\r\n${SYNC_CLOSE}`;

    expect(append(undefined, firstFrame + latestFrame).content).toBe(latestFrame);
  });

  it("retains or synthesizes a balanced synchronized-output opener", () => {
    expect(append(undefined, `${SYNC_OPEN}${FULL_REDRAW}frame${SYNC_CLOSE}`).content).toBe(
      `${SYNC_OPEN}${FULL_REDRAW}frame${SYNC_CLOSE}`,
    );
    expect(append(undefined, `obsolete${SYNC_CLOSE}${FULL_REDRAW}frame${SYNC_CLOSE}`).content).toBe(
      `${SYNC_OPEN}${FULL_REDRAW}frame${SYNC_CLOSE}`,
    );
  });

  it("detects a redraw sequence split across PTY chunks", () => {
    const first = append(undefined, "old frame\r\n\x1b[2J\x1b[H");
    expect(append(first, "\x1b[3Jnew frame").content).toBe(`${SYNC_OPEN}${FULL_REDRAW}new frame`);
  });

  it("stays invalid after overflow instead of replaying an ANSI continuation", () => {
    const overflow = append(undefined, "\x1b[38;2;100;120;", 10);
    expect(overflow.awaitingCheckpoint).toBe(true);

    const continuation = append(overflow, "140mWorking...", 10);
    expect(continuation).toMatchObject({ content: "", awaitingCheckpoint: true });
  });

  it("recovers from overflow only when a full checkpoint arrives", () => {
    let state = append(undefined, "an unsafe and oversized \x1b[", 10);
    state = append(state, `31mignored${FULL_REDRAW.slice(0, 8)}`, 100);
    expect(state).toMatchObject({ content: "", awaitingCheckpoint: true });

    state = append(state, `${FULL_REDRAW.slice(8)}recovered${SYNC_CLOSE}`, 100);
    expect(state).toEqual({
      content: `${SYNC_OPEN}${FULL_REDRAW}recovered${SYNC_CLOSE}`,
      awaitingCheckpoint: false,
      checkpointPrefix: "",
    });
  });

  it("stays invalid when the checkpoint itself exceeds the cap", () => {
    const state = append(undefined, `${FULL_REDRAW}${"x".repeat(50)}`, 20);
    expect(state).toMatchObject({ content: "", awaitingCheckpoint: true });
  });

  it("handles disabled and empty buffers", () => {
    expect(append(undefined, "")).toMatchObject({ content: "", awaitingCheckpoint: false });
    expect(append(undefined, "new", 0)).toMatchObject({ content: "", awaitingCheckpoint: true });
  });

  it("overflows without discarding a usable frame when pi never full-redraws", () => {
    // pi's TUI first render is `fullRender(false)`: it writes every line from
    // row 0 but emits NO clear sequence, so nothing is checkpointed until the
    // pty resizes. A resume-history dump followed by the first frame can
    // exceed the cap before any full redraw exists.
    const firstFrame = `${SYNC_OPEN}line one\r\nline two\r\n${SYNC_CLOSE}`;
    const dump = `${firstFrame}${SYNC_OPEN}${firstFrame}${SYNC_CLOSE}`.repeat(10);
    const overflowed = append(undefined, dump, 100);
    expect(overflowed).toMatchObject({ content: "", awaitingCheckpoint: true });

    // The pty resize on a remount forces the TUI into a full redraw; that
    // frame is the checkpoint the recovery shimmy relies on.
    const recovered = append(overflowed, `${SYNC_OPEN}${FULL_REDRAW}current screen${SYNC_CLOSE}`, 100);
    expect(recovered).toMatchObject({
      content: `${SYNC_OPEN}${FULL_REDRAW}current screen${SYNC_CLOSE}`,
      awaitingCheckpoint: false,
    });
  });
});
