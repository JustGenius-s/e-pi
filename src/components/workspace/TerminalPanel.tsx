import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { ArrowDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useTerminalTheme } from "../../hooks/useTerminalTheme";
import { getAppearance, subscribeAppearance } from "../../lib/appearance";
import { createXterm, getTerminalBackground } from "../../lib/xterm";

interface TerminalPanelProps {
  sessionKey: string;
  /** Focus the terminal while it is interactive (e.g. a trust prompt on a freshly created session). */
  autoFocus?: boolean;
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
 * Smoothly scroll the terminal to the bottom. xterm has no built-in animated
 * scrolling, so step towards the bottom with requestAnimationFrame, easing
 * the remaining distance (each frame covers 1/5 of what's left). Falls back
 * to an instant jump when the scrollback is huge and the animation would
 * drag on.
 */
function animateScrollToBottom(terminal: Terminal): void {
  const MAX_FRAMES = 30;
  let frames = 0;
  const step = () => {
    const remaining = terminal.buffer.active.baseY - terminal.buffer.active.viewportY;
    if (remaining <= 0) return;
    if (frames >= MAX_FRAMES) {
      terminal.scrollToBottom();
      return;
    }
    frames += 1;
    terminal.scrollLines(Math.max(1, Math.ceil(remaining / 5)));
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

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

export function TerminalPanel({ sessionKey, autoFocus }: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitTimerRef = useRef<number | undefined>(undefined);
  const fittedOnceRef = useRef(false);
  const [atBottom, setAtBottom] = useState(true);
  const isDarkRef = useTerminalTheme(hostRef, terminalRef);

  useEffect(() => {
    if (!hostRef.current) return;
    ensureBufferFeeder();

    // xterm paints its own canvas, so use the rendered workspace color instead
    // of leaving the terminal on a separate hard-coded background.
    const surfaceBackground = getTerminalBackground(hostRef.current);

    const terminal = createXterm({
      isDark: isDarkRef.current,
      background: surfaceBackground,
      fontSize: getAppearance().termMain,
      lineHeight: 1.32,
      scrollback: 12_000,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    // Warp-style GPU rendering: glyphs are cached in a texture atlas, so a
    // resize only repositions quads instead of clearing and repainting the
    // whole canvas — no intermediate frames, no reflow flicker.
    let webgl: WebglAddon | undefined;
    try {
      webgl = new WebglAddon();
      terminal.loadAddon(webgl);
    } catch {
      // WebGL unavailable (headless/software rendering) — xterm falls back
      // to its canvas renderer, which still works, just with repaint flicker.
    }
    terminal.open(hostRef.current);
    terminalRef.current = terminal;

    const scrollSub = terminal.onScroll(() => {
      setAtBottom(terminal.buffer.active.viewportY >= terminal.buffer.active.baseY);
    });

    /**
     * Refit the terminal to its container. With the WebGL renderer (glyph
     * atlas) a refit only repositions quads, so following the panel width
     * live — even per frame while dragging — is flicker-free and the grid
     * never shows a stale layout. The canvas fallback repaints the whole
     * canvas per resize, so it debounces to a single refit once the width
     * settles.
     */
    let disposed = false;
    const fitTerminal = () => {
      const host = hostRef.current;
      if (!host) return;
      try {
        // Skip the refit when the character grid did not change (e.g.
        // sub-pixel width wobble) — resizing repaints the renderer.
        const dims = fit.proposeDimensions();
        if (!dims) return;
        if (dims.cols === terminal.cols && dims.rows === terminal.rows) return;
      } catch {
        // The terminal can be measured before its parent is visible.
        return;
      }
      const refit = () => {
        // Capture the viewport by line, not pixel: reflow re-wraps the whole
        // scrollback, so a pixel offset no longer maps to the same content
        // (and the browser/xterm may clamp it to the new scroll height, which
        // is the "jumps back to top" bug). Line numbers survive reflow.
        const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
        const topLine = terminal.buffer.active.viewportY;
        try {
          fit.fit();
        } catch {
          return;
        }
        // refit() is coalesced (see fitTerminal below), so this is at most
        // once per resize pause — one PTY resize, one TUI re-layout.
        window.ePi.runtime.resize(sessionKey, { cols: terminal.cols, rows: terminal.rows });
        // xterm's resize schedules its own viewport sync on a refresh callback
        // (viewport.queueSync -> _sync on rAF, with scroll events suppressed
        // meanwhile). Restoring immediately races that sync and can
        // occasionally leave the viewport pinned at the top of the
        // scrollback. Wait two frames for xterm to settle, then restore — and
        // only when the viewport clearly drifted (clamped to top / bottom),
        // so a position xterm kept itself is never disturbed.
        const restoreScroll = () => {
          if (disposed) return;
          if (wasAtBottom) {
            terminal.scrollToBottom();
          } else if (Math.abs(terminal.buffer.active.viewportY - topLine) > 5) {
            terminal.scrollToLine(topLine);
          }
        };
        requestAnimationFrame(() => requestAnimationFrame(restoreScroll));
      };
      if (!fittedOnceRef.current) {
        // First mount: fit immediately so the terminal has a size right away.
        fittedOnceRef.current = true;
        refit();
      } else {
        // Coalesce refits while the window/panel width is being dragged: a
        // per-frame refit repaints the renderer every frame (visible as a
        // flicker) and reflows the scrollback repeatedly. xterm stays on the
        // last settled size until resizing pauses, then refits once — which
        // also means one PTY resize and one TUI re-layout per pause.
        window.clearTimeout(fitTimerRef.current);
        fitTimerRef.current = window.setTimeout(refit, 150);
      }
    };
    const resizeObserver = new ResizeObserver(fitTerminal);
    resizeObserver.observe(hostRef.current);
    fittedOnceRef.current = false;
    fitTerminal();

    // Live font-size updates from the Appearance settings (refit reflows the
    // grid; the skip-if-unchanged guard makes this a no-op when nothing moves).
    const unsubscribeAppearance = subscribeAppearance(() => {
      terminal.options.fontSize = getAppearance().termMain;
      fitTerminal();
    });

    const replay = buffers.get(sessionKey);
    if (replay) terminal.write(replay);

    const stopData = window.ePi.runtime.onAnyData((path, data) => {
      if (disposed || path !== sessionKey) return;
      terminal.write(data);
    });
    const input = terminal.onData((data) => window.ePi.runtime.write(sessionKey, data));

    return () => {
      disposed = true;
      unsubscribeAppearance();
      stopData();
      input.dispose();
      scrollSub.dispose();
      terminalRef.current = null;
      window.clearTimeout(fitTimerRef.current);
      webgl?.dispose();
      resizeObserver.disconnect();
      terminal.dispose();
    };
  }, [isDarkRef, sessionKey]);

  useEffect(() => {
    if (autoFocus) terminalRef.current?.focus();
  }, [autoFocus]);

  return (
    <>
      <div className="terminal-panel" ref={hostRef} aria-label="Pi terminal output" />
      <button
        type="button"
        className="terminal-scroll-bottom"
        data-visible={atBottom ? "false" : "true"}
        aria-hidden={atBottom}
        tabIndex={atBottom ? -1 : 0}
        onClick={() => {
          const terminal = terminalRef.current;
          if (terminal) animateScrollToBottom(terminal);
        }}
        aria-label="Scroll to bottom"
        title="Scroll to bottom"
      >
        <ArrowDown size={14} />
      </button>
    </>
  );
}
