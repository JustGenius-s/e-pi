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
        const viewport = host.querySelector<HTMLElement>(".xterm-viewport");
        const beforeScrollTop = viewport?.scrollTop ?? 0;
        const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
        try {
          fit.fit();
          window.ePi.runtime.resize(sessionKey, { cols: terminal.cols, rows: terminal.rows });
        } catch {
          return;
        }
        // Restore the scroll position so the visible line range doesn't jump:
        // stick to the (possibly new) bottom when following output, otherwise
        // keep the previous pixel offset for continuity.
        if (wasAtBottom) {
          terminal.scrollToBottom();
        } else if (viewport && viewport.scrollTop !== beforeScrollTop) {
          viewport.scrollTop = beforeScrollTop;
        }
      };
      if (webgl || !fittedOnceRef.current) {
        // Live refit (WebGL) or first mount: run immediately.
        fittedOnceRef.current = true;
        refit();
      } else {
        // Canvas fallback: collapse repeated fires into one refit.
        window.clearTimeout(fitTimerRef.current);
        fitTimerRef.current = window.setTimeout(refit, 120);
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
