import { Terminal } from "@xterm/xterm";

import { terminalTheme } from "./terminalTheme";

export interface XtermOptions {
  isDark: boolean;
  background: string;
  fontSize: number;
  lineHeight: number;
  scrollback: number;
}

export function createXterm({ isDark, background, fontSize, lineHeight, scrollback }: XtermOptions): Terminal {
  return new Terminal({
    allowProposedApi: false,
    convertEol: true,
    cursorBlink: false,
    cursorStyle: "bar",
    // Bold + ANSI yellow must not jump to the bright palette (highlighter on white).
    drawBoldTextInBrightColors: false,
    fontFamily: '"SFMono-Regular", "Cascadia Code", "JetBrains Mono", monospace',
    fontSize,
    lineHeight,
    scrollback,
    // xterm v6 routes programmatic scrolls through a SmoothScrollingOperation
    // (combine/reuseAnimation). Viewport._sync applies scrollHeight and
    // scrollTop in two non-atomic steps, so while an animation is alive a
    // clamped intermediate scrollTop (0 on the first sync, when scrollHeight
    // is still 0) gets baked into the animation's `from` keyframe and the
    // viewport sticks at the top of the scrollback. Disabling smooth scroll
    // makes every _sync land synchronously via setScrollPositionNow.
    smoothScrollDuration: 0,
    theme: terminalTheme(isDark, background),
  });
}

export function getTerminalBackground(host: HTMLDivElement): string {
  return getComputedStyle(host.parentElement ?? host).backgroundColor || "#000000";
}
