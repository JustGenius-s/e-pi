import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { ArrowDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useTerminalTheme } from "../../hooks/useTerminalTheme";
import { getAppearance, subscribeAppearance } from "../../lib/appearance";
import { ensureTerminalBufferFeeder } from "../../lib/terminalBufferFeeder";
import { decodeOsc52Clipboard } from "../../lib/terminalOsc52";
import { clearTerminalBuffer, getReplayContent } from "../../lib/terminalReplayStore";
import { createTerminalResizeOutputGate } from "../../lib/terminalResizeOutputGate";
import { createTerminalResizeVisualGuard } from "../../lib/terminalResizeVisualGuard";
import {
  createPiViewportWheelBatcher,
  decodePiViewportStatePayload,
  getPiViewportCell,
  PI_SCROLL_TO_BOTTOM_INPUT,
  PI_VIEWPORT_OSC_ID,
  wheelDeltaToTerminalRows,
} from "../../lib/terminalViewportProtocol";
import { ansiForDocumentTheme } from "../../lib/tui-ansi-light";
import { createXterm, getTerminalBackground } from "../../lib/xterm";
import { createResizeScheduler } from "../../lib/xtermResizeScheduler";
import type { ResizeScheduler } from "../../lib/xtermResizeScheduler";
import { guardEraseScrollback } from "../../lib/xtermScrollbackGuard";
import { createViewportWatchdog } from "../../lib/xtermViewportWatchdog";
import { StockTerminalPanel } from "./StockTerminalPanel";

export interface TerminalPanelProps {
  sessionKey: string;
  /** Whether Pi reserves the bottom fade area inside its optimized transcript. */
  tuiOptimizationsEnabled?: boolean;
  /** Focus the terminal while it is interactive (e.g. a trust prompt on a freshly created session). */
  autoFocus?: boolean;
  /** Fired once when the terminal first receives output for this session (replay or live). */
  onFirstPaint?: (sessionKey: string) => void;
  /** Open a workspace file (from OSC 8 file links) in the built-in editor. */
  onOpenFileLink?: (absPath: string, line?: number) => void;
}

const LOCATION_FRAGMENT_PATTERN = /^#L([1-9]\d*)(?:-L?([1-9]\d*))?$/i;
const SYNCHRONIZED_OUTPUT_CLOSE = "\x1b[?2026l";

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

function OptimizedTerminalPanel({
  sessionKey,
  tuiOptimizationsEnabled = true,
  autoFocus,
  onFirstPaint,
  onOpenFileLink,
}: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const scrollToBottomRef = useRef<() => void>(() => undefined);
  const [atBottom, setAtBottom] = useState(true);
  const isDarkRef = useTerminalTheme(hostRef, terminalRef);
  // Keep the latest callback without re-running the mount effect.
  const onFirstPaintRef = useRef(onFirstPaint);
  onFirstPaintRef.current = onFirstPaint;
  const onOpenFileLinkRef = useRef(onOpenFileLink);
  onOpenFileLinkRef.current = onOpenFileLink;

  useEffect(() => {
    if (!hostRef.current) return;
    ensureTerminalBufferFeeder();

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
    // GPU rendering keeps glyph work cheap during streaming and repeated local
    // reflows. The resize guard captures only while a resize transaction is
    // active, so normal output keeps WebGL's fast non-preserved back buffer.
    let webgl: WebglAddon | undefined;
    try {
      webgl = new WebglAddon();
      terminal.loadAddon(webgl);
    } catch {
      // WebGL unavailable (headless/software rendering): the canvas renderer
      // is protected by the same visual double-buffer transaction.
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
    setAtBottom(true);
    let authoritativeViewportSeen = false;
    const viewportWheelBatcher = createPiViewportWheelBatcher({
      write: (input) => window.ePi.runtime.write(sessionKey, input),
    });
    terminal.attachCustomWheelEventHandler((event) => {
      if (!authoritativeViewportSeen) return true;
      // Keep horizontal wheel gestures inert while bypassing xterm's
      // low-frequency terminal-mouse conversion for the authoritative view.
      if (event.deltaY === 0 || event.shiftKey) return false;

      const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
      if (!screen) return true;
      const rect = screen.getBoundingClientRect();
      const cell = getPiViewportCell(event.clientX, event.clientY, {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        columns: terminal.cols,
        rows: terminal.rows,
      });
      if (!cell) return true;

      const deltaRows = wheelDeltaToTerminalRows(
        event.deltaY,
        event.deltaMode,
        rect.height / terminal.rows,
        terminal.rows,
      );
      viewportWheelBatcher.push(deltaRows, cell.x, cell.y);
      return false;
    });
    // Fullscreen Pi owns mouse selection and sends the selected UTF-8 text as
    // OSC 52. Accept only the clipboard target and a bounded, canonical base64
    // payload before crossing the preload boundary into Electron's clipboard.
    const osc52Clipboard = terminal.parser.registerOscHandler(52, (data) => {
      const text = decodeOsc52Clipboard(data);
      if (text !== null) void window.ePi.app.copyText(text).catch(() => undefined);
      return true;
    });
    const viewportStateOsc = terminal.parser.registerOscHandler(PI_VIEWPORT_OSC_ID, (data) => {
      const viewport = decodePiViewportStatePayload(data);
      if (!viewport) return false;
      authoritativeViewportSeen = true;
      setAtBottom(viewport.followingEnd);
      return true;
    });
    const resizeVisualGuard = createTerminalResizeVisualGuard(terminal);

    const scrollSub = terminal.onScroll(() => {
      if (authoritativeViewportSeen) return;
      setAtBottom(terminal.buffer.active.viewportY >= terminal.buffer.active.baseY);
    });

    // Self-heal: if xterm's internal scroll state ever diverges from the
    // buffer viewport (a swallowed scroll event, a clamp the app never
    // observed), the `atBottom` state above never updates again and the
    // viewport appears stuck. The watchdog re-derives it from the buffer.
    const viewportWatchdog = createViewportWatchdog(terminal, (nextAtBottom) => {
      if (!authoritativeViewportSeen) setAtBottom(nextAtBottom);
    });

    scrollToBottomRef.current = () => {
      if (authoritativeViewportSeen) {
        window.ePi.runtime.write(sessionKey, PI_SCROLL_TO_BOTTOM_INPUT);
        return;
      }
      animateScrollToBottom(terminal);
    };

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
    let resizeShimmyFinalSize: { cols: number; rows: number } | undefined;
    let handleSkippedResizeCheckpoint = (): void => undefined;
    let replaying = true;
    let queuedLiveData = "";
    /** Initial writes (replay + queued live chunks) all committed and rendered. */
    let initialWritesSettled = false;
    /**
     * An empty replay means the picture depends on pi's NEXT frame: either
     * its very first render (fresh session) or a full redraw forced by the
     * checkpoint shimmy (buffer was invalidated by overflow). pi's TUI only
     * emits a full frame on first render/resize — its steady-state output is
     * differential (changed lines only), which would paint a partial screen
     * (input box, no history) on a blank terminal. So the loading overlay
     * must NOT lift until that full frame actually arrived.
     */
    const replay = getReplayContent(sessionKey);
    let waitingForFirstFrame = replay.length === 0;
    // Any empty replay is incomplete, including a full renderer reload where
    // the module-level replay store was recreated. Bootstrap it with the same
    // atomic checkpoint handshake used after LRU/overflow invalidation.
    let waitingForCheckpoint = replay.length === 0;
    let bootstrapCheckpointPending = replay.length === 0;
    const markPainted = (): void => {
      if (painted || disposed) return;
      painted = true;
      onFirstPaintRef.current?.(sessionKey);
    };
    /**
     * The loading overlay lifts once the initial output has actually been
     * painted. xterm.write is async (parse + render happen on later frames),
     * so firing on "chunk arrived" reveals a half-drawn terminal; wait until
     * every initial write committed and two render frames passed.
     */
    const settleInitialWrites = (): void => {
      if (disposed || painted || initialWritesSettled) return;
      if (waitingForFirstFrame || waitingForCheckpoint) return;
      if (pendingWrites > 0) return;
      initialWritesSettled = true;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          markPainted();
        });
      });
    };
    let pendingWrites = 0;
    const flushWrite = (data: string, onWritten?: () => void) => {
      pendingWrites += 1;
      const payload = ansiForDocumentTheme(data);
      terminal.write(payload, () => {
        pendingWrites -= 1;
        onWritten?.();
        settleInitialWrites();
      });
    };
    let resizeScheduler: ResizeScheduler | undefined;
    const resizeOutputGate = createTerminalResizeOutputGate({
      write: (data, onWritten) => flushWrite(data, onWritten),
      onCheckpointRecovered: () => {
        resizeShimmyFinalSize = undefined;
        if (waitingForCheckpoint) waitingForCheckpoint = false;
        // The write callback is parser-ordered, but the canvas render lands on
        // a later frame. Atomically capture that complete frame before either
        // advancing the single-flight resize pipeline or revealing xterm.
        resizeVisualGuard.presentAfterRender(() => {
          const acknowledged = resizeScheduler?.acknowledgeResize() ?? false;
          if (!acknowledged) resizeVisualGuard.release();
        });
        requestAnimationFrame(syncViewportAfterWrite);
        settleInitialWrites();
      },
      onCheckpointSkipped: () => handleSkippedResizeCheckpoint(),
    });

    /**
     * Force a checkpoint without ever displaying the intermediate height.
     * The output gate discards the complete rows+1 frame first; only after that
     * handshake do we restore the final size and wait for its authoritative
     * frame. This cannot collapse into a single coalesced SIGWINCH.
     */
    const triggerAtomicCheckpointShimmy = (cols: number, rows: number): void => {
      resizeShimmyFinalSize = { cols, rows };
      resizeOutputGate.commit({
        expectedSize: { cols, rows: rows + 1 },
        skipCompleteFrames: 1,
      });
      window.ePi.runtime.resize(sessionKey, { cols, rows: rows + 1 });
    };
    handleSkippedResizeCheckpoint = () => {
      const finalSize = resizeShimmyFinalSize;
      if (disposed || !finalSize) return;
      resizeShimmyFinalSize = undefined;
      resizeOutputGate.commit({ expectedSize: finalSize });
      window.ePi.runtime.resize(sessionKey, finalSize);
    };
    /**
     * Refit the terminal to its container. Panel collapse/expand animates the
     * width over ~180ms; per-frame settle detection refits within a couple of
     * frames of the size going stable, and the current screen is repainted at
     * the new container width while the transition is still running — the
     * user never sees a frozen old-layout frame. See xtermResizeScheduler.
     */
    resizeScheduler = createResizeScheduler({
      terminal,
      fit,
      // A synchronized frame can be between IPC chunks even after xterm's
      // write queue drains. Treat that open frame as pending too, then place
      // a synthetic close behind all already-queued bytes. New live bytes are
      // gated from onResizeStart onward, so the barrier is finite and always
      // leaves the renderer able to paint the local preview.
      hasPendingWrites: () => pendingWrites > 0 || terminal.modes.synchronizedOutputMode,
      queueWriteBarrier: (onDrained) => {
        terminal.write(SYNCHRONIZED_OUTPUT_CLOSE, () => {
          if (disposed) return;
          onDrained();
        });
      },
      onResizeStart: () => {
        resizeShimmyFinalSize = undefined;
        resizeOutputGate.begin();
      },
      prepareResizeVisual: (onReady) => resizeVisualGuard.begin(onReady),
      onResizePreviewReady: () => {
        resizeVisualGuard.track();
      },
      onResizeCommit: (size) => {
        resizeOutputGate.commit({ expectedSize: size });
      },
      onResizeCancel: () => {
        const result = resizeOutputGate.cancel();
        if (result === "needs-checkpoint") {
          resizeVisualGuard.hold();
          triggerAtomicCheckpointShimmy(terminal.cols, terminal.rows);
        } else {
          resizeVisualGuard.endAfterRender();
        }
      },
      onResizeSettled: () => {
        resizeVisualGuard.release();
      },
      onFitted: ({ cols, rows }) => {
        if (bootstrapCheckpointPending) {
          bootstrapCheckpointPending = false;
          // The workspace loading veil already covers an empty replay. Avoid
          // priming a resize snapshot before the first real frame exists.
          triggerAtomicCheckpointShimmy(cols, rows);
          return;
        }
        // Every measurable animation frame can supersede an older resize. The
        // tagged output gate drops late Pi frames before they reach xterm.
        window.ePi.runtime.resize(sessionKey, { cols, rows });
      },
    });
    const resizeObserver = new ResizeObserver(() => resizeScheduler.schedule());

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
    const stopData = window.ePi.runtime.onAnyData((path, data) => {
      if (disposed || path !== sessionKey) return;
      if (replaying) queuedLiveData += data;
      else resizeOutputGate.push(data);
      // A full frame (fresh first render, or the shimmy-triggered redraw)
      // arrived — the terminal can now paint the complete picture, so the
      // loading overlay may lift once this chunk is committed.
      if (waitingForFirstFrame) {
        waitingForFirstFrame = false;
        settleInitialWrites();
      }
    });
    // Subscribe before the first PTY resize. A fresh/empty replay uses that
    // resize to start its atomic checkpoint handshake; installing the listener
    // afterwards could miss the very frame needed to send the final size.
    resizeObserver.observe(hostRef.current);
    resizeScheduler.refitNow();
    const finishReplay = () => {
      if (disposed) return;
      replaying = false;
      if (queuedLiveData) {
        const queued = queuedLiveData;
        queuedLiveData = "";
        resizeOutputGate.push(queued);
      }
      // With an empty replay the overlay stays until the first real frame
      // arrives (see waitingForFirstFrame / waitingForCheckpoint above).
      // The replay write (and any queued live data) is parsed by now; xterm's
      // viewport sync for it runs on the next refresh callback. Re-assert the
      // viewport afterwards so a remounted terminal that landed on the top of
      // the scrollback (stale sync, swallowed scroll event) is corrected.
      requestAnimationFrame(syncViewportAfterWrite);
    };
    if (replay) {
      flushWrite(replay, finishReplay);
    } else {
      finishReplay();
    }
    const input = terminal.onData((data) => window.ePi.runtime.write(sessionKey, data));

    return () => {
      disposed = true;
      resizeScheduler?.dispose();
      resizeVisualGuard.dispose();
      resizeOutputGate.dispose();
      eraseScrollbackGuard.dispose();
      viewportWatchdog.dispose();
      viewportWheelBatcher.dispose();
      unsubscribeAppearance();
      stopData();
      stopState();
      input.dispose();
      scrollSub.dispose();
      scrollToBottomRef.current = () => undefined;
      terminalRef.current = null;
      osc52Clipboard.dispose();
      viewportStateOsc.dispose();
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
      <div
        className="terminal-panel"
        data-bottom-inset={tuiOptimizationsEnabled ? "tui" : undefined}
        ref={hostRef}
        aria-label="Pi terminal output"
      />
      <div className="terminal-bottom-fade" aria-hidden="true" />
      <button
        type="button"
        className="terminal-scroll-bottom"
        data-visible={atBottom ? "false" : "true"}
        aria-hidden={atBottom}
        tabIndex={atBottom ? -1 : 0}
        onClick={() => scrollToBottomRef.current()}
        aria-label="Scroll to bottom"
        title="Scroll to bottom"
      >
        <ArrowDown size={14} />
      </button>
    </>
  );
}

/** Select the complete stock or optimized terminal pipeline at mount time. */
export function TerminalPanel(props: TerminalPanelProps) {
  if (props.tuiOptimizationsEnabled === false) return <StockTerminalPanel {...props} />;
  return <OptimizedTerminalPanel {...props} />;
}
