import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { memo, useEffect, useRef, useState } from "react";

import { useTerminalTheme } from "../../hooks/useTerminalTheme";
import { getAppearance, subscribeAppearance } from "../../lib/appearance";
import { createXterm, getTerminalBackground } from "../../lib/xterm";
import { createResizeScheduler } from "../../lib/xtermResizeScheduler";
import { guardEraseScrollback } from "../../lib/xtermScrollbackGuard";

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
    let resizeScheduler: ReturnType<typeof createResizeScheduler> | undefined;
    let unsubscribeAppearance: (() => void) | undefined;
    let eraseScrollbackGuard: { dispose(): void } | undefined;

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
      // Same parse-time `3J` suppression as the main terminal: `clear` (or any
      // program emitting erase-scrollback) must not yank a scrolled-up
      // viewport to the top.
      eraseScrollbackGuard = guardEraseScrollback(terminal);

      /**
       * Xterm's viewport only re-syncs its scrollable state from the buffer
       * when the scroll position actually changes. On a fresh spawn the
       * internal state can sit at scrollTop 0 while the buffer has already
       * been positioned by the first output burst; nudging by one line (and
       * straight back) forces the sync so the position the user sees and the
       * buffer agree before any user scroll happens.
       */
      const primeViewportSync = () => {
        if (disposed || !terminal) return;
        const buffer = terminal.buffer.active;
        if (buffer.baseY > 0 && buffer.viewportY >= buffer.baseY) {
          terminal.scrollLines(1);
          terminal.scrollToBottom();
        }
      };
      resizeScheduler = createResizeScheduler({
        terminal: terminal!,
        fit,
        // The side terminal has no write-batch tracking; the shell's own
        // reflow on SIGWINCH handles any transient mismatch.
        hasPendingWrites: () => false,
        queueWriteBarrier: (onDrained) => onDrained(),
        onFitted: ({ cols, rows }) => {
          if (id) window.ePi.sideTerminal.resize(id, { cols, rows });
        },
        isDisposed: () => disposed,
      });
      resizeObserver = new ResizeObserver(() => resizeScheduler!.schedule());
      resizeObserver.observe(hostRef.current);
      resizeScheduler.refitNow();

      // Live font-size updates from the Appearance settings.
      unsubscribeAppearance = subscribeAppearance(() => {
        terminal!.options.fontSize = getAppearance().termSide;
        resizeScheduler!.schedule();
      });

      stopData = window.ePi.sideTerminal.onData((dataId, data) => {
        if (dataId === id) terminal!.write(data, primeViewportSync);
      });
      inputDisposable = terminal.onData((data) => {
        if (id) window.ePi.sideTerminal.write(id, data);
      });
      setState("ready");
    };

    void start();

    return () => {
      disposed = true;
      resizeScheduler?.dispose();
      if (id) window.ePi.sideTerminal.kill(id);
      stopData?.();
      inputDisposable?.dispose();
      resizeObserver?.disconnect();
      terminal?.dispose();
      terminalRef.current = null;
      unsubscribeAppearance?.();
      eraseScrollbackGuard?.dispose();
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
