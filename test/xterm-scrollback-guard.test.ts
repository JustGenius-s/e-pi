import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";

import { guardEraseScrollback } from "../src/lib/xtermScrollbackGuard";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build a terminal with a populated scrollback and the guard registered, then
 * scroll up into history. xterm parses `write()` asynchronously (setTimeout),
 * so every test awaits a settle before asserting.
 */
async function buildScrolledUpTerminal(): Promise<InstanceType<typeof Terminal>> {
  const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 12_000, convertEol: true });
  guardEraseScrollback(terminal);
  let frame = "";
  for (let i = 0; i < 200; i += 1) frame += `line-${i}\r\n`;
  terminal.write(frame);
  await sleep(50);
  terminal.scrollLines(-100);
  expect(terminal.buffer.active.viewportY).toBeGreaterThan(0);
  expect(terminal.buffer.active.viewportY).toBeLessThan(terminal.buffer.active.baseY);
  return terminal;
}

describe("guardEraseScrollback (parse-time 3J suppression)", () => {
  it("keeps the viewport and history when a full redraw with 3J arrives while scrolled up", async () => {
    const terminal = await buildScrolledUpTerminal();
    const before = { ydisp: terminal.buffer.active.viewportY, ybase: terminal.buffer.active.baseY };

    // The pi TUI full-redraw sequence (as emitted on every PTY resize).
    terminal.write("\x1b[?2026h\x1b[2J\x1b[H\x1b[3J");
    await sleep(30);

    expect(terminal.buffer.active.viewportY).toBe(before.ydisp);
    expect(terminal.buffer.active.baseY).toBe(before.ybase);
    // The history itself survives: the scrollback is still intact.
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("line-0");
  });

  it("suppresses the DECSED variant ESC[?3J too", async () => {
    const terminal = await buildScrolledUpTerminal();
    const before = terminal.buffer.active.viewportY;

    terminal.write("\x1b[?3J");
    await sleep(30);

    expect(terminal.buffer.active.viewportY).toBe(before);
    expect(terminal.buffer.active.baseY).toBeGreaterThan(before);
  });

  it("suppresses parameter variants 3;0J and 3:0J", async () => {
    const terminal = await buildScrolledUpTerminal();
    const before = terminal.buffer.active.viewportY;

    terminal.write("\x1b[3;0J");
    await sleep(30);
    terminal.write("\x1b[3:0J");
    await sleep(30);

    expect(terminal.buffer.active.viewportY).toBe(before);
  });

  it("closes the queue/parse race: a 3J queued at the bottom cannot yank the viewport after the user scrolls up", async () => {
    const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 12_000, convertEol: true });
    guardEraseScrollback(terminal);
    let frame = "";
    for (let i = 0; i < 200; i += 1) frame += `line-${i}\r\n`;
    terminal.write(frame);
    await sleep(50);
    expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY); // at the bottom

    // Queue the full redraw while the viewport is at the bottom, then scroll
    // up BEFORE xterm's async parser runs. The old queue-time guard decided
    // "at bottom -> let 3J through" at queue time and the late parse yanked
    // the viewport to the top; the parse-time guard must not.
    terminal.write("\x1b[2J\x1b[H\x1b[3J");
    terminal.scrollLines(-100);
    expect(terminal.buffer.active.viewportY).toBeGreaterThan(0);

    await sleep(50); // let the queued 3J parse

    expect(terminal.buffer.active.viewportY).toBeGreaterThan(0);
    expect(terminal.buffer.active.baseY).toBe(terminal.buffer.active.viewportY + 100);
  });

  it("leaves other erase-in-display params intact (0J, 2J)", async () => {
    const terminal = await buildScrolledUpTerminal();

    terminal.write("\x1b[0J");
    await sleep(30);
    terminal.write("\x1b[2J");
    await sleep(30);

    // 0J/2J must still have run: the screen rows of the buffer are blank.
    const buffer = terminal.buffer.active;
    const screenStart = buffer.baseY;
    const line = buffer.getLine(screenStart)?.translateToString(true) ?? "";
    expect(line.trim()).toBe("");
  });

  it("lets history accumulate across repeated full redraws without stale-frame growth", async () => {
    const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 12_000, convertEol: true });
    guardEraseScrollback(terminal);
    let stream = "";
    for (let i = 0; i < 60; i += 1) stream += `stream-line-${i}\r\n`;
    terminal.write(stream);
    await sleep(30);
    const baseAfterStream = terminal.buffer.active.baseY;

    for (let round = 0; round < 5; round += 1) {
      let redraw = "\x1b[2J\x1b[H\x1b[3J";
      const rows: string[] = [];
      for (let i = 0; i < 24; i += 1) rows.push(`frame-${round}-row-${i}`);
      redraw += rows.join("\r\n");
      terminal.write(redraw);
      await sleep(30);
      // Only real stream growth (4 lines per round) may accumulate.
      terminal.write("\r\nstream-line-extra-a\r\nstream-line-extra-b");
      await sleep(30);
    }

    // 60 stream lines scrolled 37 into history (24 stay on screen), then 5
    // rounds × 2 extra lines: 37 + 10 = 47. Redraws must not add anything.
    expect(terminal.buffer.active.baseY).toBe(baseAfterStream + 10);
  });

  it("disposing the guard restores the default 3J behavior", async () => {
    const other = new Terminal({ cols: 80, rows: 24, scrollback: 12_000, convertEol: true });
    const guard = guardEraseScrollback(other);
    guard.dispose();
    let frame = "";
    for (let i = 0; i < 200; i += 1) frame += `line-${i}\r\n`;
    other.write(frame);
    await sleep(50);
    other.scrollLines(-100);
    const before = other.buffer.active.viewportY;

    other.write("\x1b[3J");
    await sleep(30);

    // Default behavior returns: the scrollback is trimmed and the viewport
    // clamps toward the top.
    expect(other.buffer.active.baseY).toBe(0);
    expect(other.buffer.active.viewportY).toBeLessThan(before);
  });
});
