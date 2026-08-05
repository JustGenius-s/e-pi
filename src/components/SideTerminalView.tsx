import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { memo, useEffect, useRef, useState } from "react";

import { getAppearance, subscribeAppearance } from "../lib/appearance";
import { terminalTheme } from "../lib/terminalTheme";
import { useIsDark } from "../lib/useIsDark";

interface SideTerminalViewProps {
  cwd: string;
}

/**
 * Embedded interactive shell in the tool panel. The pty lives in the main
 * process and is killed when this view unmounts (switching view or closing
 * the panel); re-opening starts a fresh shell.
 */
export const SideTerminalView = memo(function SideTerminalView({ cwd }: SideTerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [state, setState] = useState<"starting" | "ready" | "error">("starting");
  const [error, setError] = useState<string>();
  const isDark = useIsDark();
  // Latest-value ref so the mount effect can read the theme without re-running
  // (recreating the terminal) when the theme flips — the update effect below
  // handles live repaints instead.
  const isDarkRef = useRef(isDark);
  isDarkRef.current = isDark;

  useEffect(() => {
    let disposed = false;
    let terminal: Terminal | undefined;
    let id: string | undefined;
    let stopData: (() => void) | undefined;
    let inputDisposable: { dispose(): void } | undefined;
    let scrollDisposable: { dispose(): void } | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let unsubscribeAppearance: (() => void) | undefined;

    const start = async () => {
      if (!hostRef.current) return;
      try {
        id = await window.ePi.sideTerminal.spawn(cwd);
      } catch (reason) {
        if (!disposed) {
          setError(reason instanceof Error ? reason.message : String(reason));
          setState("error");
        }
        return;
      }
      if (disposed) {
        window.ePi.sideTerminal.kill(id);
        return;
      }

      const surface = hostRef.current.parentElement ?? hostRef.current;
      const surfaceBackground = getComputedStyle(surface).backgroundColor || "#000000";
      terminal = new Terminal({
        allowProposedApi: false,
        convertEol: true,
        cursorBlink: false,
        cursorStyle: "bar",
        fontFamily: '"SFMono-Regular", "Cascadia Code", "JetBrains Mono", monospace',
        fontSize: getAppearance().termSide,
        lineHeight: 1.35,
        scrollback: 8_000,
        theme: terminalTheme(isDarkRef.current, surfaceBackground),
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(hostRef.current);
      terminalRef.current = terminal;

      const fitTerminal = () => {
        try {
          fit.fit();
          if (id) window.ePi.sideTerminal.resize(id, { cols: terminal!.cols, rows: terminal!.rows });
        } catch {
          // Terminal may not be measurable yet.
        }
      };
      resizeObserver = new ResizeObserver(fitTerminal);
      resizeObserver.observe(hostRef.current);
      fitTerminal();

      // Live font-size updates from the Appearance settings.
      unsubscribeAppearance = subscribeAppearance(() => {
        terminal!.options.fontSize = getAppearance().termSide;
        fitTerminal();
      });

      stopData = window.ePi.sideTerminal.onData((dataId, data) => {
        if (dataId === id) terminal!.write(data);
      });
      inputDisposable = terminal.onData((data) => {
        if (id) window.ePi.sideTerminal.write(id, data);
      });
      scrollDisposable = terminal.onScroll(() => {
        // No-op; kept for parity with TerminalPanel if needed later.
      });
      setState("ready");
    };

    void start();

    return () => {
      disposed = true;
      if (id) window.ePi.sideTerminal.kill(id);
      stopData?.();
      inputDisposable?.dispose();
      scrollDisposable?.dispose();
      resizeObserver?.disconnect();
      terminal?.dispose();
      terminalRef.current = null;
      unsubscribeAppearance?.();
    };
  }, [cwd]);

  // Repaint the terminal when the app theme flips.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const surface = hostRef.current?.parentElement ?? hostRef.current;
    const surfaceBackground = surface ? getComputedStyle(surface).backgroundColor || "#000000" : "#000000";
    terminal.options.theme = terminalTheme(isDark, surfaceBackground);
  }, [isDark]);

  return (
    <div className="git-panel-body">
      {state === "starting" ? <div className="git-empty-panel">启动终端…</div> : null}
      {state === "error" ? <div className="git-error">{error}</div> : null}
      <div className="tool-terminal-host" ref={hostRef} aria-label="Embedded terminal" />
    </div>
  );
});
