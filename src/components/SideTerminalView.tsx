import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { LayoutPanelLeft } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

interface SideTerminalViewProps {
  cwd: string;
  onBack: () => void;
}

/**
 * Embedded interactive shell in the tool panel. The pty lives in the main
 * process and is killed when this view unmounts (switching view or closing
 * the panel); re-opening starts a fresh shell.
 */
export const SideTerminalView = memo(function SideTerminalView({ cwd, onBack }: SideTerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [state, setState] = useState<"starting" | "ready" | "error">("starting");
  const [error, setError] = useState<string>();

  useEffect(() => {
    let disposed = false;
    let terminal: Terminal | undefined;
    let id: string | undefined;
    let stopData: (() => void) | undefined;
    let inputDisposable: { dispose(): void } | undefined;
    let scrollDisposable: { dispose(): void } | undefined;
    let resizeObserver: ResizeObserver | undefined;

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
        fontSize: 11,
        lineHeight: 1.35,
        scrollback: 8_000,
        theme: {
          background: surfaceBackground,
          foreground: "#d7e0e9",
          cursor: "#74d6a5",
          selectionBackground: "#314b58",
          black: "#18212a",
          red: "#ed8b92",
          green: "#74d6a5",
          yellow: "#e3c47a",
          blue: "#8db9e8",
          magenta: "#c6a1df",
          cyan: "#72c6c7",
          white: "#d7e0e9",
          brightBlack: "#526171",
          brightRed: "#ff9b9f",
          brightGreen: "#8be6b4",
          brightYellow: "#f3d994",
          brightBlue: "#a9cdf5",
          brightMagenta: "#dbb8f1",
          brightCyan: "#91e2e0",
          brightWhite: "#f0f4f7",
        },
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
    };
  }, [cwd]);

  return (
    <div className="git-panel-body">
      {state === "starting" ? <div className="git-empty-panel">启动终端…</div> : null}
      {state === "error" ? <div className="git-error">{error}</div> : null}
      <div className="tool-terminal-host" ref={hostRef} aria-label="Embedded terminal" />
      <div className="tool-view-bar">
        <button type="button" className="tool-view-bar-back" onClick={onBack}>
          <LayoutPanelLeft size={12} />
          内容列表
        </button>
      </div>
    </div>
  );
});
