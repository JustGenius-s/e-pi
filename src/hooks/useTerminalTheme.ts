import type { Terminal } from "@xterm/xterm";
import { useEffect, useRef, type RefObject } from "react";

import { terminalTheme } from "../lib/terminalTheme";
import { getTerminalBackground } from "../lib/xterm";
import { useIsDark } from "./useIsDark";

/** Keeps an already-mounted xterm instance synchronized with the document theme. */
export function useTerminalTheme(
  hostRef: RefObject<HTMLDivElement | null>,
  terminalRef: RefObject<Terminal | null>,
): RefObject<boolean> {
  const isDark = useIsDark();
  const isDarkRef = useRef(isDark);
  isDarkRef.current = isDark;

  useEffect(() => {
    const terminal = terminalRef.current;
    const host = hostRef.current;
    if (!terminal || !host) return;
    terminal.options.theme = terminalTheme(isDark, getTerminalBackground(host));
  }, [isDark, hostRef, terminalRef]);

  return isDarkRef;
}
