import { describe, expect, it } from "vitest";

import { ScrollbackGuard } from "../src/lib/scrollbackGuard";

describe("ScrollbackGuard", () => {
  it("strips ESC[3J (erase scrollback) while protecting", () => {
    const guard = new ScrollbackGuard();
    expect(guard.transform("a\x1b[3Jb", true)).toBe("ab");
  });

  it("strips the DECSED variant ESC[?3J while protecting", () => {
    const guard = new ScrollbackGuard();
    expect(guard.transform("x\x1b[?3Jy", true)).toBe("xy");
  });

  it("keeps the full-redraw sequence minus the scrollback erase", () => {
    const guard = new ScrollbackGuard();
    expect(guard.transform("\x1b[?2026h\x1b[2J\x1b[H\x1b[3Jframe", true)).toBe("\x1b[?2026h\x1b[2J\x1b[Hframe");
  });

  it("passes the stream through untouched when not protecting", () => {
    const guard = new ScrollbackGuard();
    expect(guard.transform("a\x1b[3Jb", false)).toBe("a\x1b[3Jb");
  });

  it("carries a split CSI prefix across chunks and strips it once complete", () => {
    const guard = new ScrollbackGuard();
    expect(guard.transform("\x1b[", true)).toBe("");
    expect(guard.transform("3J", true)).toBe("");

    const other = new ScrollbackGuard();
    expect(other.transform("a\x1b[", true)).toBe("a");
    expect(other.transform("3Jb", true)).toBe("b");
  });

  it("does not mis-handle other CSI sequences split across chunks", () => {
    const guard = new ScrollbackGuard();
    // ESC[2 is a legal prefix; it is carried and re-emitted whole next chunk.
    expect(guard.transform("a\x1b[2", true)).toBe("a");
    expect(guard.transform("J", true)).toBe("\x1b[2J");

    const color = new ScrollbackGuard();
    expect(color.transform("a\x1b[3", true)).toBe("a");
    expect(color.transform("0mb", true)).toBe("\x1b[30mb");
  });

  it("does not strip erase-line (K), other J params, or non-CSI text", () => {
    const guard = new ScrollbackGuard();
    expect(guard.transform("\x1b[K\x1b[2J\x1b[33J\x1b[0Jhello", true)).toBe("\x1b[K\x1b[2J\x1b[33J\x1b[0Jhello");
  });

  it("ignores empty chunks and keeps state intact", () => {
    const guard = new ScrollbackGuard();
    expect(guard.transform("", true)).toBe("");
    expect(guard.transform("\x1b[", true)).toBe("");
    expect(guard.transform("", true)).toBe("");
    expect(guard.transform("3J", true)).toBe("");
  });

  it("strips the parameter-list form ESC[3;0J whose first param is 3", () => {
    const guard = new ScrollbackGuard();
    expect(guard.transform("\x1b[3;0J", true)).toBe("");
  });
});
