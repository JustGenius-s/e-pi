import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { ArrowDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useTerminalTheme } from "../../hooks/useTerminalTheme";
import { getAppearance, subscribeAppearance } from "../../lib/appearance";
import { ScrollbackGuard } from "../../lib/scrollbackGuard";
import { appendTerminalReplay } from "../../lib/terminalReplayBuffer";
import type { TerminalReplayBuffer } from "../../lib/terminalReplayBuffer";
import { createXterm, getTerminalBackground } from "../../lib/xterm";
import { restoreViewportAfterSettle } from "../../lib/xtermViewportRestore";

interface TerminalPanelProps {
  sessionKey: string;
  /** Focus the terminal while it is interactive (e.g. a trust prompt on a freshly created session). */
  autoFocus?: boolean;
  /** Fired once when the terminal first receives output for this session (replay or live). */
  onFirstPaint?: (sessionKey: string) => void;
}

/**
 * Scrollback per session, kept across terminal unmount/remount (switching to
 * another session destroys the xterm instance). A hidden session keeps
 * accumulating output in the background via the app-lifetime feeder below, so
 * switching back replays the latest self-contained TUI frame plus subsequent
 * output. Obsolete full-redraw frames are compacted instead of replayed.
 */
const buffers = new Map<string, TerminalReplayBuffer>();

export function clearTerminalBuffer(sessionKey: string): void {
  buffers.delete(sessionKey);
}

function appendTerminalBuffer(sessionKey: string, data: string): void {
  buffers.set(sessionKey, appendTerminalReplay(buffers.get(sessionKey), data));
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

export function TerminalPanel({ sessionKey, autoFocus, onFirstPaint }: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitTimerRef = useRef<number | undefined>(undefined);
  const fittedOnceRef = useRef(false);
  const [atBottom, setAtBottom] = useState(true);
  // Mirrors `atBottom` for use inside IPC/PTY callbacks (no re-render needed).
  const atBottomRef = useRef(true);
  const isDarkRef = useTerminalTheme(hostRef, terminalRef);
  // Keep the latest callback without re-running the mount effect.
  const onFirstPaintRef = useRef(onFirstPaint);
  onFirstPaintRef.current = onFirstPaint;

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
    // pi's TUI emits OSC 8 hyperlinks (URLs in tool output, package pages,
    // …). xterm does not handle links on its own, so register the official
    // link addon. Like a system terminal, open on ⌘/Ctrl+click only, so a
    // stray click never yanks the browser open. The sandboxed renderer's
    // window.open is intercepted by the main process
    // (setWindowOpenHandler → shell.openExternal), which is the existing
    // path for opening external URLs.
    const webLinks = new WebLinksAddon((event, uri) => {
      if (event.metaKey || event.ctrlKey) window.open(uri, "_blank", "noopener");
    });
    terminal.loadAddon(webLinks);
    terminal.open(hostRef.current);
    terminalRef.current = terminal;

    const scrollSub = terminal.onScroll(() => {
      const bottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
      atBottomRef.current = bottom;
      setAtBottom(bottom);
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
    let painted = false;
    /** Pending second half of the checkpoint-recovery height shimmy. */
    let shimmyTimer: number | undefined = undefined;
    const markPainted = (): void => {
      if (painted || disposed) return;
      painted = true;
      onFirstPaintRef.current?.(sessionKey);
    };
    let restoreGeneration = 0;
    let pendingWrites = 0;
    let deferredRefit = false;
    let resizeBarrierQueued = false;
    let runResizeBarrier: (() => void) | undefined;
    // Bump the generation so any in-flight viewport restore from a previous
    // refit aborts at its next frame check. cancelAnimationFrame cannot stop a
    // callback that is already executing (it would reschedule itself), so the
    // generation check inside the restore loop is the real guard.
    const cancelPendingRestore = () => {
      restoreGeneration += 1;
    };
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
        // xterm parses writes asynchronously. Resizing while a TUI frame is
        // still queued makes the producer and emulator disagree about cursor
        // coordinates; the next spinner update can then scroll instead of
        // replacing its row. Wait until the current write batch is committed.
        if (pendingWrites > 0) {
          deferredRefit = true;
          if (!resizeBarrierQueued) {
            resizeBarrierQueued = true;
            // An empty write is an explicit FIFO barrier behind all terminal
            // data queued so far. This prevents a sustained stream from
            // starving resize forever while preserving parser ordering.
            terminal.write("", () => {
              resizeBarrierQueued = false;
              if (disposed || !deferredRefit) return;
              runResizeBarrier?.();
            });
          }
          return;
        }
        deferredRefit = false;

        // A previous refit may still have a delayed restoration queued. If it
        // runs after this refit, its old line number can move the viewport to
        // the wrong place (including the top) after a second reflow.
        cancelPendingRestore();

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
        // The replay checkpoint buffer can be invalidated by overflow: a long
        // resume-history dump or an output-heavy run can exceed the cap before
        // the TUI's next full redraw, and pi's TUI only re-emits a full frame
        // when the pty size changes. On a remount the resize above is usually a
        // no-op (the pty already has this size), so nothing would ever repaint
        // the replayed (empty) terminal. Shimmy the height and restore it to
        // force the TUI into a full redraw: the live frame repaints the current
        // screen and plants a fresh checkpoint in the replay buffer. The two
        // resizes must straddle a TUI render tick (MIN_RENDER_INTERVAL_MS is
        // 16ms) or the intermediate size is never observed and the redraw is
        // skipped.
        if (buffers.get(sessionKey)?.awaitingCheckpoint) {
          const { cols, rows } = terminal;
          window.ePi.runtime.resize(sessionKey, { cols, rows: rows + 1 });
          window.clearTimeout(shimmyTimer);
          shimmyTimer = window.setTimeout(() => {
            if (disposed) return;
            window.ePi.runtime.resize(sessionKey, { cols, rows });
          }, 60);
        }
        // xterm's resize schedules its own viewport sync on a refresh callback
        // (viewport.queueSync -> _sync on rAF) that can run AFTER a fixed-delay
        // restore and clamp the viewport back to the top of the scrollback.
        // Restore only once the viewport has stopped moving on its own, so the
        // restore lands after xterm's sync instead of racing it. The stale
        // check makes a newer refit (or unmount) abort the loop at the next
        // frame.
        const generation = restoreGeneration;
        restoreViewportAfterSettle({
          terminal,
          wasAtBottom,
          topLine,
          isStale: () => disposed || generation !== restoreGeneration,
        });
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

    runResizeBarrier = fitTerminal;

    // While the user is scrolled up in history, strip `ESC[3J` (erase
    // scrollback) from the stream: pi's TUI emits it on every full redraw and
    // xterm responds by resetting ydisp to 0, yanking the viewport back to
    // the top. At the bottom the trim is invisible and stays enabled.
    const scrollbackGuard = new ScrollbackGuard();
    const flushWrite = (data: string, onWritten?: () => void) => {
      pendingWrites += 1;
      terminal.write(scrollbackGuard.transform(data, !atBottomRef.current), () => {
        pendingWrites -= 1;
        onWritten?.();
      });
    };

    // Subscribe before taking the replay snapshot. IPC dispatch is ordered, so
    // the app-lifetime feeder has already appended each event by the time this
    // listener sees it. Live chunks arriving while xterm parses the snapshot
    // are queued and appended afterwards, preventing both gaps and reordering.
    let replaying = true;
    let queuedLiveData = "";
    const stopData = window.ePi.runtime.onAnyData((path, data) => {
      if (disposed || path !== sessionKey) return;
      markPainted();
      if (replaying) queuedLiveData += data;
      else flushWrite(data);
    });
    const finishReplay = () => {
      if (disposed) return;
      replaying = false;
      if (queuedLiveData) {
        const queued = queuedLiveData;
        queuedLiveData = "";
        flushWrite(queued);
      }
    };
    const replay = buffers.get(sessionKey)?.content;
    if (replay) {
      markPainted();
      flushWrite(replay, finishReplay);
    } else {
      finishReplay();
    }
    const input = terminal.onData((data) => window.ePi.runtime.write(sessionKey, data));

    return () => {
      disposed = true;
      window.clearTimeout(shimmyTimer);
      cancelPendingRestore();
      unsubscribeAppearance();
      stopData();
      input.dispose();
      scrollSub.dispose();
      terminalRef.current = null;
      window.clearTimeout(fitTimerRef.current);
      webgl?.dispose();
      webLinks.dispose();
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
