import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { ArrowDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useTerminalTheme } from "../../hooks/useTerminalTheme";
import { getAppearance, subscribeAppearance } from "../../lib/appearance";
import { ensureTerminalBufferFeeder } from "../../lib/terminalBufferFeeder";
import { consumeTerminalModeReset, getReplayContent, isAwaitingCheckpoint } from "../../lib/terminalReplayStore";
import { ansiForDocumentTheme } from "../../lib/tui-ansi-light";
import { createXterm, getTerminalBackground } from "../../lib/xterm";
import { fitToTerminalElement } from "../../lib/xtermFit";
import { createStockResizeScheduler } from "../../lib/xtermResizeSchedulerStock";
import { guardEraseScrollback } from "../../lib/xtermScrollbackGuard";
import { createViewportWatchdog } from "../../lib/xtermViewportWatchdog";
import type { TerminalPanelProps } from "./TerminalPanel";

const LOCATION_FRAGMENT_PATTERN = /^#L([1-9]\d*)(?:-L?([1-9]\d*))?$/i;

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
  } else if (!/^([a-zA-Z]:[\\/]|\/)/.test(path)) {
    return null;
  }
  if (!path) return null;
  return { path, line };
}

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

/** Terminal implementation preserved from the local master branch. */
export function StockTerminalPanel({ sessionKey, autoFocus, onFirstPaint, onOpenFileLink }: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const isDarkRef = useTerminalTheme(hostRef, terminalRef);
  const onFirstPaintRef = useRef(onFirstPaint);
  onFirstPaintRef.current = onFirstPaint;
  const onOpenFileLinkRef = useRef(onOpenFileLink);
  onOpenFileLinkRef.current = onOpenFileLink;

  useEffect(() => {
    if (!hostRef.current) return;
    ensureTerminalBufferFeeder();

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
    fitToTerminalElement(fit, terminal);
    let webgl: WebglAddon | undefined;
    try {
      webgl = new WebglAddon();
      terminal.loadAddon(webgl);
    } catch {
      // xterm falls back to its canvas renderer when WebGL is unavailable.
    }
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
    const viewportWatchdog = createViewportWatchdog(terminal, setAtBottom);

    const syncViewportAfterWrite = () => {
      if (disposed) return;
      viewportWatchdog.check();
    };

    let disposed = false;
    let painted = false;
    let shimmyTimer: number | undefined;
    let initialWritesSettled = false;
    const replay = getReplayContent(sessionKey);
    const modeReset = consumeTerminalModeReset(sessionKey);
    let waitingForFirstFrame = replay.length === 0;
    let waitingForCheckpoint = replay.length === 0 && isAwaitingCheckpoint(sessionKey) && !modeReset;
    const markPainted = (): void => {
      if (painted || disposed) return;
      painted = true;
      onFirstPaintRef.current?.(sessionKey);
    };
    const settleInitialWrites = (): void => {
      if (disposed || painted || initialWritesSettled) return;
      if (waitingForFirstFrame || waitingForCheckpoint || pendingWrites > 0) return;
      initialWritesSettled = true;
      requestAnimationFrame(() => {
        requestAnimationFrame(markPainted);
      });
    };
    let pendingWrites = 0;
    let pendingWriteBytes = 0;
    const triggerCheckpointShimmy = (cols: number, rows: number) => {
      window.ePi.runtime.resize(sessionKey, { cols, rows: rows + 1 });
      window.clearTimeout(shimmyTimer);
      shimmyTimer = window.setTimeout(() => {
        if (disposed) return;
        window.ePi.runtime.resize(sessionKey, { cols, rows });
      }, 60);
    };
    const resizeScheduler = createStockResizeScheduler({
      terminal,
      fit,
      hasPendingWrites: () => pendingWrites > 0,
      pendingWriteBytes: () => pendingWriteBytes,
      queueWriteBarrier: (onDrained) => {
        terminal.write("", () => {
          if (disposed) return;
          onDrained();
        });
      },
      onFitted: ({ cols, rows }) => {
        window.ePi.runtime.resize(sessionKey, { cols, rows });
        if (isAwaitingCheckpoint(sessionKey)) triggerCheckpointShimmy(cols, rows);
      },
    });
    const resizeObserver = new ResizeObserver(() => resizeScheduler.schedule());
    resizeObserver.observe(hostRef.current);
    resizeScheduler.refitNow();

    const unsubscribeAppearance = subscribeAppearance(() => {
      terminal.options.fontSize = getAppearance().termMain;
      resizeScheduler.schedule();
    });
    const eraseScrollbackGuard = guardEraseScrollback(terminal);
    const flushWrite = (data: string, onWritten?: () => void) => {
      pendingWrites += 1;
      const payload = ansiForDocumentTheme(data);
      pendingWriteBytes += payload.length;
      terminal.write(payload, () => {
        pendingWrites -= 1;
        pendingWriteBytes -= payload.length;
        onWritten?.();
        settleInitialWrites();
      });
    };

    let bootGeneration: number | undefined;
    void window.ePi.runtime.getStates().then((states) => {
      if (disposed) return;
      bootGeneration = states[sessionKey]?.generation ?? 0;
    });
    const stopState = window.ePi.runtime.onState((state) => {
      if (disposed || state.sessionPath !== sessionKey) return;
      if (bootGeneration === undefined) {
        bootGeneration = state.generation;
        return;
      }
      if (state.generation <= bootGeneration) return;
      bootGeneration = state.generation;
      terminal.reset();
      window.ePi.runtime.resize(sessionKey, { cols: terminal.cols, rows: terminal.rows });
      requestAnimationFrame(syncViewportAfterWrite);
    });

    let replaying = true;
    let queuedLiveData = "";
    const stopData = window.ePi.runtime.onAnyData((path, data) => {
      if (disposed || path !== sessionKey) return;
      if (replaying) queuedLiveData += data;
      else flushWrite(data);
      if (waitingForCheckpoint && !isAwaitingCheckpoint(sessionKey)) {
        waitingForCheckpoint = false;
        settleInitialWrites();
      }
      if (waitingForFirstFrame) {
        waitingForFirstFrame = false;
        settleInitialWrites();
      }
    });
    const finishReplay = () => {
      if (disposed) return;
      replaying = false;
      if (queuedLiveData) {
        const queued = queuedLiveData;
        queuedLiveData = "";
        flushWrite(queued);
      }
      requestAnimationFrame(syncViewportAfterWrite);
    };
    if (replay) flushWrite(replay, finishReplay);
    else finishReplay();
    if (!replay && (modeReset || isAwaitingCheckpoint(sessionKey))) {
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
