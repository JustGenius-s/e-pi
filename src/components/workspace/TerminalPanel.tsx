import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { ArrowDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useTerminalTheme } from "../../hooks/useTerminalTheme";
import { getAppearance, subscribeAppearance } from "../../lib/appearance";
import {
  appendTerminalBuffer,
  clearTerminalBuffer,
  getReplayContent,
  isAwaitingCheckpoint,
} from "../../lib/terminalReplayStore";
import { createXterm, getTerminalBackground } from "../../lib/xterm";
import { createResizeScheduler } from "../../lib/xtermResizeScheduler";
import { guardEraseScrollback } from "../../lib/xtermScrollbackGuard";
import { createViewportWatchdog } from "../../lib/xtermViewportWatchdog";

interface TerminalPanelProps {
  sessionKey: string;
  /** Focus the terminal while it is interactive (e.g. a trust prompt on a freshly created session). */
  autoFocus?: boolean;
  /** Fired once when the terminal first receives output for this session (replay or live). */
  onFirstPaint?: (sessionKey: string) => void;
  /** Open a workspace file (from OSC 8 file links) in the built-in editor. */
  onOpenFileLink?: (absPath: string, line?: number) => void;
}

const LOCATION_FRAGMENT_PATTERN = /^#L([1-9]\d*)(?:-L?([1-9]\d*))?$/i;

/**
 * Parse an OSC 8 link uri as a workspace file reference: `file:///abs/path`
 * or a plain absolute path, optionally with a `#L10` / `#L10-L20` line
 * fragment. Returns null when the uri is not a file reference.
 */
function parseWorkspaceFileLink(uri: string): { path: string; line?: number } | null {
  let path = uri.trim();
  let line: number | undefined;
  const hashIndex = path.lastIndexOf("#");
  if (hashIndex >= 0) {
    const fragment = path.slice(hashIndex);
    const match = LOCATION_FRAGMENT_PATTERN.exec(fragment);
    if (match) {
      line = Number(match[1]);
      path = path.slice(0, hashIndex);
    }
  }
  if (path.startsWith("file://")) {
    try {
      path = decodeURIComponent(path.slice("file://".length));
    } catch {
      path = path.slice("file://".length);
    }
  } else {
    // Only absolute paths qualify; anything else is an external link.
    if (!/^([a-zA-Z]:[\\/]|\/)/.test(path)) return null;
  }
  if (!path) return null;
  return { path, line };
}

let feederStarted = false;

// Backward-compatible entry point for consumers that historically imported
// clearTerminalBuffer from this component; the storage lives in the store.
export { clearTerminalBuffer };

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

export function TerminalPanel({ sessionKey, autoFocus, onFirstPaint, onOpenFileLink }: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const isDarkRef = useTerminalTheme(hostRef, terminalRef);
  // Keep the latest callback without re-running the mount effect.
  const onFirstPaintRef = useRef(onFirstPaint);
  onFirstPaintRef.current = onFirstPaint;
  const onOpenFileLinkRef = useRef(onOpenFileLink);
  onOpenFileLinkRef.current = onOpenFileLink;

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
    // stray click never yanks the browser open. Workspace file links (file://
    // or absolute paths with an optional #L<line> suffix) open in the built-in
    // editor; everything else goes through window.open, which the main process
    // intercepts (setWindowOpenHandler → shell.openExternal).
    const webLinks = new WebLinksAddon((event, uri) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const parsed = parseWorkspaceFileLink(uri);
      if (parsed && onOpenFileLinkRef.current) {
        event.preventDefault();
        onOpenFileLinkRef.current(parsed.path, parsed.line);
        return;
      }
      window.open(uri, "_blank", "noopener");
    });
    terminal.loadAddon(webLinks);
    terminal.open(hostRef.current);
    terminalRef.current = terminal;

    const scrollSub = terminal.onScroll(() => {
      setAtBottom(terminal.buffer.active.viewportY >= terminal.buffer.active.baseY);
    });

    // Self-heal: if xterm's internal scroll state ever diverges from the
    // buffer viewport (a swallowed scroll event, a clamp the app never
    // observed), the `atBottom` state above never updates again and the
    // viewport appears stuck. The watchdog re-derives it from the buffer.
    const viewportWatchdog = createViewportWatchdog(terminal, setAtBottom);

    /** Re-assert the viewport from the buffer after xterm syncs replay/reset output. */
    const syncViewportAfterWrite = () => {
      if (disposed) return;
      viewportWatchdog.check();
    };

    /**
     * Refit the terminal to its container. Panel collapse/expand animates the
     * width over ~180ms; per-frame settle detection refits within a couple of
     * frames of the size going stable, and the current screen is repainted at
     * the new container width while the transition is still running — the
     * user never sees a frozen old-layout frame.
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
    let pendingWrites = 0;
    /**
     * Checkpoint-recovery height shimmy: the replay buffer can be invalidated
     * by overflow or LRU eviction, and pi's TUI only re-emits a full frame
     * when the pty size changes. Nudge the height and restore it so the live
     * frame repaints the current screen and plants a fresh checkpoint. The
     * two resizes must straddle a TUI render tick (MIN_RENDER_INTERVAL_MS is
     * 16ms) or the intermediate size is never observed and the redraw is
     * skipped.
     */
    const triggerCheckpointShimmy = (cols: number, rows: number) => {
      window.ePi.runtime.resize(sessionKey, { cols, rows: rows + 1 });
      window.clearTimeout(shimmyTimer);
      shimmyTimer = window.setTimeout(() => {
        if (disposed) return;
        window.ePi.runtime.resize(sessionKey, { cols, rows });
      }, 60);
    };
    /**
     * Refit the terminal to its container. Panel collapse/expand animates the
     * width over ~180ms; per-frame settle detection refits within a couple of
     * frames of the size going stable, and the current screen is repainted at
     * the new container width while the transition is still running — the
     * user never sees a frozen old-layout frame. See xtermResizeScheduler.
     */
    const resizeScheduler = createResizeScheduler({
      terminal,
      fit,
      hasPendingWrites: () => pendingWrites > 0,
      queueWriteBarrier: (onDrained) => {
        terminal.write("", () => {
          if (disposed) return;
          onDrained();
        });
      },
      onFitted: ({ cols, rows }) => {
        // One PTY resize per refit pause — the TUI re-lays out once.
        window.ePi.runtime.resize(sessionKey, { cols, rows });
        // The replay checkpoint buffer can be invalidated by overflow: a long
        // resume-history dump or an output-heavy run can exceed the cap before
        // the TUI's next full redraw. On a remount the resize above is usually
        // a no-op (the pty already has this size), so nothing would ever
        // repaint the replayed (empty) terminal — shimmy the height instead.
        if (isAwaitingCheckpoint(sessionKey)) {
          triggerCheckpointShimmy(cols, rows);
        }
      },
    });
    const resizeObserver = new ResizeObserver(() => resizeScheduler.schedule());
    resizeObserver.observe(hostRef.current);
    resizeScheduler.refitNow();

    // Live font-size updates from the Appearance settings (refit reflows the
    // grid; the skip-if-unchanged guard makes this a no-op when nothing moves).
    const unsubscribeAppearance = subscribeAppearance(() => {
      terminal.options.fontSize = getAppearance().termMain;
      resizeScheduler.schedule();
    });

    // pi's TUI emits `ESC[2J ESC[H ESC[3J` full redraws whenever the PTY
    // resizes or its layout changes. Executing `3J` would trim the whole
    // scrollback and clamp ydisp to 0 — yanking a scrolled-up viewport back
    // to the top and destroying the history the user is reading. Suppress it
    // at parse time: a queue-time stream filter would race with xterm's
    // asynchronous parser (see xtermScrollbackGuard).
    const eraseScrollbackGuard = guardEraseScrollback(terminal);
    const flushWrite = (data: string, onWritten?: () => void) => {
      pendingWrites += 1;
      terminal.write(data, () => {
        pendingWrites -= 1;
        onWritten?.();
      });
    };

    // Re-sync after a process restart (sidebar "Reload session"): the new
    // pty spawns at pi's default 120x36 grid, while this xterm keeps its
    // real size — so the fit guard below sees no change and never sends a
    // resize, leaving pi to lay out at 120 columns (wrapped wrongly on
    // wider terminals) on top of the previous session's stale screen (the
    // replay buffer was cleared, so nothing repaints it). When the bridge
    // reports a fresh generation, reset the terminal and re-assert the real
    // grid size; the pty resize makes pi repaint a full frame correctly.
    // Baseline generation for restart detection. onState only fires on state
    // CHANGES, so a session running quietly (no busy/idle transitions) never
    // triggers it after mount — the baseline would stay undefined and the
    // first post-reload state would be misread as the baseline. Query the
    // current generation up front instead.
    let bootGeneration: number | undefined;
    void window.ePi.runtime.getStates().then((states) => {
      if (disposed) return;
      bootGeneration = states[sessionKey]?.generation ?? 0;
    });
    const stopState = window.ePi.runtime.onState((state) => {
      if (disposed || state.sessionPath !== sessionKey) return;
      if (bootGeneration === undefined) {
        // First state report after mount: record the baseline generation so
        // a normal first launch (0 → 1) never counts as a restart.
        bootGeneration = state.generation;
        return;
      }
      if (state.generation <= bootGeneration) return;
      bootGeneration = state.generation;
      terminal.reset();
      window.ePi.runtime.resize(sessionKey, { cols: terminal.cols, rows: terminal.rows });
      // The repainted full frame after the pty resize re-syncs xterm's
      // viewport asynchronously; re-assert position once it settles.
      requestAnimationFrame(syncViewportAfterWrite);
    });

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
      // The replay write (and any queued live data) is parsed by now; xterm's
      // viewport sync for it runs on the next refresh callback. Re-assert the
      // viewport afterwards so a remounted terminal that landed on the top of
      // the scrollback (stale sync, swallowed scroll event) is corrected.
      requestAnimationFrame(syncViewportAfterWrite);
    };
    const replay = getReplayContent(sessionKey);
    if (replay) {
      markPainted();
      flushWrite(replay, finishReplay);
    } else {
      finishReplay();
    }
    // A session whose buffer was LRU-evicted (or invalidated) remounts with
    // an empty replay. The shimmy above only fires inside onFitted, which
    // never runs when the grid is unchanged (refitNow's guard no-ops) — so
    // nothing would force pi to repaint and the terminal stays blank. Trigger
    // the height shimmy right away using the already-fit grid size.
    if (!replay && isAwaitingCheckpoint(sessionKey)) {
      triggerCheckpointShimmy(terminal.cols, terminal.rows);
    }
    const input = terminal.onData((data) => window.ePi.runtime.write(sessionKey, data));

    return () => {
      disposed = true;
      window.clearTimeout(shimmyTimer);
      resizeScheduler.dispose();
      eraseScrollbackGuard.dispose();
      viewportWatchdog.dispose();
      unsubscribeAppearance();
      stopData();
      stopState();
      input.dispose();
      scrollSub.dispose();
      terminalRef.current = null;
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
