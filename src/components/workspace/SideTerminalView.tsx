import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { memo, useEffect, useRef, useState } from "react";

import { useTerminalTheme } from "../../hooks/useTerminalTheme";
import { getAppearance, subscribeAppearance } from "../../lib/appearance";
import { createXterm, getTerminalBackground } from "../../lib/xterm";

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
  const isDarkRef = useTerminalTheme(hostRef, terminalRef);

  useEffect(() => {
    let disposed = false;
    let terminal: Terminal | undefined;
    let id: string | undefined;
    let stopData: (() => void) | undefined;
    let inputDisposable: { dispose(): void } | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let fitTimer: number | undefined;
    let restoreGeneration = 0;
    let restoreFrame1: number | undefined;
    let restoreFrame2: number | undefined;
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

      terminal = createXterm({
        isDark: isDarkRef.current,
        background: getTerminalBackground(hostRef.current),
        fontSize: getAppearance().termSide,
        lineHeight: 1.35,
        scrollback: 8_000,
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(hostRef.current);
      terminalRef.current = terminal;

      const cancelPendingRestore = () => {
        restoreGeneration += 1;
        if (restoreFrame1 !== undefined) {
          cancelAnimationFrame(restoreFrame1);
          restoreFrame1 = undefined;
        }
        if (restoreFrame2 !== undefined) {
          cancelAnimationFrame(restoreFrame2);
          restoreFrame2 = undefined;
        }
      };
      const fitTerminal = () => {
        try {
          const dims = fit.proposeDimensions();
          if (!dims || (dims.cols === terminal!.cols && dims.rows === terminal!.rows)) return;
          window.clearTimeout(fitTimer);
          fitTimer = undefined;
          cancelPendingRestore();

          // xterm reflows scrollback when its column count changes. Preserve
          // the logical line rather than the pixel offset, then wait for its
          // queued viewport sync before restoring it. Without this, a resize
          // can intermittently clamp the side terminal to the top.
          const wasAtBottom = terminal!.buffer.active.viewportY >= terminal!.buffer.active.baseY;
          const topLine = terminal!.buffer.active.viewportY;
          fit.fit();
          if (id) window.ePi.sideTerminal.resize(id, { cols: terminal!.cols, rows: terminal!.rows });

          const generation = restoreGeneration;
          restoreFrame1 = requestAnimationFrame(() => {
            restoreFrame1 = undefined;
            restoreFrame2 = requestAnimationFrame(() => {
              restoreFrame2 = undefined;
              if (disposed || generation !== restoreGeneration) return;
              if (wasAtBottom) terminal!.scrollToBottom();
              else if (Math.abs(terminal!.buffer.active.viewportY - topLine) > 5) terminal!.scrollToLine(topLine);
            });
          });
        } catch {
          // Terminal may not be measurable yet.
        }
      };
      resizeObserver = new ResizeObserver(() => {
        // Coalesce layout notifications while the panel is being resized.
        window.clearTimeout(fitTimer);
        fitTimer = window.setTimeout(fitTerminal, 120);
      });
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
      setState("ready");
    };

    void start();

    return () => {
      disposed = true;
      window.clearTimeout(fitTimer);
      restoreGeneration += 1;
      if (restoreFrame1 !== undefined) cancelAnimationFrame(restoreFrame1);
      if (restoreFrame2 !== undefined) cancelAnimationFrame(restoreFrame2);
      if (id) window.ePi.sideTerminal.kill(id);
      stopData?.();
      inputDisposable?.dispose();
      resizeObserver?.disconnect();
      terminal?.dispose();
      terminalRef.current = null;
      unsubscribeAppearance?.();
    };
  }, [cwd, isDarkRef]);

  return (
    <div className="git-panel-body">
      {state === "starting" ? <div className="git-empty-panel">Starting terminal…</div> : null}
      {state === "error" ? <div className="git-error">{error}</div> : null}
      <div className="tool-terminal-host" ref={hostRef} aria-label="Embedded terminal" />
    </div>
  );
});
