import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";

interface TerminalPanelProps {
  sessionKey: string;
}

/**
 * Scrollback per session, kept across terminal unmount/remount (switching to
 * another session destroys the xterm instance). A hidden session keeps
 * accumulating output in the background via the app-lifetime feeder below, so
 * switching back replays exactly what the process printed while hidden.
 */
const MAX_BUFFER_CHARS = 400_000;
const buffers = new Map<string, string>();

export function clearTerminalBuffer(sessionKey: string): void {
  buffers.delete(sessionKey);
}

function appendTerminalBuffer(sessionKey: string, data: string): void {
  const next = (buffers.get(sessionKey) ?? "") + data;
  buffers.set(sessionKey, next.length > MAX_BUFFER_CHARS ? next.slice(-MAX_BUFFER_CHARS) : next);
}

let feederStarted = false;

/**
 * App-lifetime subscription: buffer every session's output regardless of which
 * terminal is visible, so nothing is lost while a session runs in the
 * background. Only starts once the first TerminalPanel mounts.
 */
function ensureBufferFeeder(): void {
  if (feederStarted) return;
  feederStarted = true;
  window.ePi.runtime.onAnyData((sessionPath, data) => appendTerminalBuffer(sessionPath, data));
}

export function TerminalPanel({ sessionKey }: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    ensureBufferFeeder();

    // xterm paints its own canvas, so use the rendered workspace color instead
    // of leaving the terminal on a separate hard-coded background.
    const surface = hostRef.current.parentElement ?? hostRef.current;
    const surfaceBackground = getComputedStyle(surface).backgroundColor || "#000000";

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: false,
      cursorStyle: "bar",
      fontFamily: '"SFMono-Regular", "Cascadia Code", "JetBrains Mono", monospace',
      fontSize: 13,
      lineHeight: 1.32,
      scrollback: 12_000,
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

    const fitTerminal = () => {
      try {
        fit.fit();
        window.ePi.runtime.resize(sessionKey, { cols: terminal.cols, rows: terminal.rows });
      } catch {
        // The terminal can be measured before its parent is visible.
      }
    };
    const resizeObserver = new ResizeObserver(fitTerminal);
    resizeObserver.observe(hostRef.current);
    fitTerminal();

    let disposed = false;
    const replay = buffers.get(sessionKey);
    if (replay) terminal.write(replay);

    const stopData = window.ePi.runtime.onAnyData((path, data) => {
      if (disposed || path !== sessionKey) return;
      terminal.write(data);
    });
    const input = terminal.onData((data) => window.ePi.runtime.write(sessionKey, data));

    return () => {
      disposed = true;
      stopData();
      input.dispose();
      resizeObserver.disconnect();
      terminal.dispose();
    };
  }, [sessionKey]);

  return <div className="terminal-panel" ref={hostRef} aria-label="Pi terminal output" />;
}
