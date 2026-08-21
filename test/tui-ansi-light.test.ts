import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";

import {
  ansiForDocumentTheme,
  DARK_WARNING_RGB,
  LIGHT_WARNING_RGB,
  recolorBakedWarningInTerminal,
  remapDarkThemeAnsiForLight,
} from "../src/lib/tui-ansi-light";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("remapDarkThemeAnsiForLight", () => {
  it("recolors baked [Skill conflicts] / Update Available warning yellow", () => {
    const input = "\x1b[38;2;255;255;0m[Skill conflicts]\x1b[39m\n\x1b[1m\x1b[38;2;255;255;0mUpdate Available\x1b[39m";
    expect(remapDarkThemeAnsiForLight(input)).toBe(
      "\x1b[38;2;107;74;0m[Skill conflicts]\x1b[39m\n\x1b[1m\x1b[38;2;107;74;0mUpdate Available\x1b[39m",
    );
  });

  it("leaves other truecolor sequences untouched", () => {
    const input = "\x1b[38;2;107;74;0mkeep\x1b[38;2;204;102;102merr";
    expect(remapDarkThemeAnsiForLight(input)).toBe(input);
  });
});

describe("ansiForDocumentTheme", () => {
  it("leaves output unchanged without a document (node / dark default)", () => {
    const input = "\x1b[38;2;255;255;0m[Skill conflicts]";
    expect(ansiForDocumentTheme(input)).toBe(input);
  });
});

describe("recolorBakedWarningInTerminal", () => {
  it("rewrites visible #ffff00 cells to e-pi-light warning gold", async () => {
    const terminal = new Terminal({ cols: 40, rows: 5, convertEol: true });
    terminal.write("\x1b[38;2;255;255;0m[Skill conflicts]\x1b[39m");
    await sleep(30);
    const before = terminal.buffer.active.getLine(0)?.getCell(0);
    expect(before?.isFgRGB()).toBe(true);
    expect(before?.getFgColor()).toBe(DARK_WARNING_RGB);

    recolorBakedWarningInTerminal(terminal, true);
    await sleep(30);

    const after = terminal.buffer.active.getLine(0)?.getCell(0);
    expect(after?.isFgRGB()).toBe(true);
    expect(after?.getFgColor()).toBe(LIGHT_WARNING_RGB);
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("[Skill conflicts]");
    terminal.dispose();
  });

  it("restores dark warning yellow when switching back", async () => {
    const terminal = new Terminal({ cols: 40, rows: 5, convertEol: true });
    terminal.write("\x1b[1m\x1b[38;2;107;74;0mUpdate Available\x1b[39m");
    await sleep(30);

    recolorBakedWarningInTerminal(terminal, false);
    await sleep(30);

    const cell = terminal.buffer.active.getLine(0)?.getCell(0);
    expect(cell?.getFgColor()).toBe(DARK_WARNING_RGB);
    expect(cell?.isBold()).toBeTruthy();
    terminal.dispose();
  });
});
