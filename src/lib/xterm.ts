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
    fontFamily: '"SFMono-Regular", "Cascadia Code", "JetBrains Mono", monospace',
    fontSize,
    lineHeight,
    scrollback,
    theme: terminalTheme(isDark, background),
  });
}

export function getTerminalBackground(host: HTMLDivElement): string {
  return getComputedStyle(host.parentElement ?? host).backgroundColor || "#000000";
}
