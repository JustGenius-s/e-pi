/**
 * Pi's built-in dark theme paints warning text as truecolor #ffff00
 * (`theme.fg("warning", …)`). [Skill conflicts] / Update Available bake that
 * ANSI into Text widgets at session start, so a later /e-pi-theme switch
 * reprints the same string. On a white xterm background the result is
 * highlighter yellow. Map the dark-theme yellow to e-pi-light's warning
 * (#6b4a00) both on new writes and on already-painted cells.
 */
import type { IBufferCell, Terminal } from "@xterm/xterm";

const DARK_THEME_YELLOW = new RegExp(`${String.fromCharCode(0x1b)}\\[(38|48);2;255;255;0m`, "g");
const LIGHT_WARNING_ANSI = "107;74;0"; // #6b4a00 — resources/e-pi-light.json vars.yellow

export const DARK_WARNING_RGB = 0xffff00;
export const LIGHT_WARNING_RGB = 0x6b4a00;

export function remapDarkThemeAnsiForLight(data: string): string {
  if (!data.includes("255;255;0")) return data;
  return data.replace(DARK_THEME_YELLOW, (_, plane: string) => `\x1b[${plane};2;${LIGHT_WARNING_ANSI}m`);
}

/** `document.documentElement` is the live source of truth — updated in applyThemeClass before IPC. */
export function isDocumentDark(): boolean {
  if (typeof document === "undefined") return true;
  return document.documentElement.classList.contains("dark");
}

/** Remap baked warning yellow when the app is already in light mode. */
export function ansiForDocumentTheme(data: string): string {
  return isDocumentDark() ? data : remapDarkThemeAnsiForLight(data);
}

function toAnsiRgb(rgb: number): string {
  return `${(rgb >> 16) & 255};${(rgb >> 8) & 255};${rgb & 255}`;
}

function rgbOf(cell: IBufferCell, plane: "fg" | "bg"): number | undefined {
  if (plane === "fg") return cell.isFgRGB() ? cell.getFgColor() : undefined;
  return cell.isBgRGB() ? cell.getBgColor() : undefined;
}

/**
 * Overwrite already-painted truecolor warning cells in the visible viewport.
 * Pi will not recreate those Text widgets on setTheme, so new PTY frames may
 * skip them; this is what makes the toggle look instantaneous.
 */
export function recolorBakedWarningInTerminal(terminal: Terminal, toLight: boolean): void {
  const from = toLight ? DARK_WARNING_RGB : LIGHT_WARNING_RGB;
  const to = toLight ? LIGHT_WARNING_RGB : DARK_WARNING_RGB;
  const buffer = terminal.buffer.active;
  const viewportY = buffer.viewportY;
  const parts: string[] = ["\x1b7"];
  let changed = false;

  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(viewportY + row);
    if (!line) continue;
    let col = 0;
    while (col < terminal.cols) {
      const cell = line.getCell(col);
      if (!cell) {
        col += 1;
        continue;
      }
      const width = cell.getWidth();
      if (width === 0) {
        col += 1;
        continue;
      }
      const fg = rgbOf(cell, "fg");
      const bg = rgbOf(cell, "bg");
      if (fg !== from && bg !== from) {
        col += width;
        continue;
      }
      const startCol = col;
      const bold = Boolean(cell.isBold());
      const italic = Boolean(cell.isItalic());
      let text = "";
      while (col < terminal.cols) {
        const current = line.getCell(col);
        if (!current || current.getWidth() === 0) break;
        if (Boolean(current.isBold()) !== bold || Boolean(current.isItalic()) !== italic) break;
        if (rgbOf(current, "fg") !== fg || rgbOf(current, "bg") !== bg) break;
        text += current.getChars() || " ";
        col += current.getWidth();
      }
      const sgr = ["0"];
      if (bold) sgr.push("1");
      if (italic) sgr.push("3");
      if (fg !== undefined) sgr.push(`38;2;${toAnsiRgb(fg === from ? to : fg)}`);
      if (bg !== undefined) sgr.push(`48;2;${toAnsiRgb(bg === from ? to : bg)}`);
      parts.push(`\x1b[${row + 1};${startCol + 1}H\x1b[${sgr.join(";")}m${text}`);
      changed = true;
    }
  }

  if (!changed) return;
  parts.push("\x1b[0m\x1b8");
  terminal.write(parts.join(""));
}
