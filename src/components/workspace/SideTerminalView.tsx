import { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import { useTerminalTheme } from "../../hooks/useTerminalTheme";
import { getAppearance, subscribeAppearance } from "../../lib/appearance";
import { DARK_PALETTE, LIGHT_PALETTE } from "../../lib/terminalTheme";
import { createXterm, getTerminalBackground } from "../../lib/xterm";
import { createResizeScheduler } from "../../lib/xtermResizeScheduler";
import { guardEraseScrollback } from "../../lib/xtermScrollbackGuard";

interface SideTerminalViewProps {
  cwd: string;
}

interface EditorState {
  value: string;
  history: string[];
  historyIndex: number | null;
}

const STATUS_POLL_MS = 400;

/** Caret position helpers for the multiline editor. */
function isCaretOnFirstLine(value: string, caret: number): boolean {
  return !value.slice(0, caret).includes("\n");
}

function isCaretOnLastLine(value: string, caret: number): boolean {
  return !value.slice(caret).includes("\n");
}

/**
 * Embedded shell in the tool panel, Warp-style: the terminal renders the
 * prompt and output, and a transparent editor overlays the prompt's cursor
 * cell so command text is freely selectable/editable without a separate
 * input widget. The prompt comes from the shell (starship etc. keeps
 * working); the editor floats exactly over where typing would appear.
 *
 * While a keystroke-driven foreground program owns the tty (vim, ssh, fzf…
 * — see side-terminal-interactive.ts), the editor steps aside, xterm
 * receives raw keystrokes, and a small badge marks the raw-input mode.
 * Plain long-running commands (sleep, builds) keep the editor active;
 * typed lines are type-ahead stdin, exactly like a normal terminal.
 *
 * The pty lives in the main process and is killed when this view unmounts.
 */
export const SideTerminalView = memo(function SideTerminalView({ cwd }: SideTerminalViewProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const ptyIdRef = useRef<string | undefined>(undefined);
  const editorStateRef = useRef<EditorState>({ value: "", history: [], historyIndex: null });
  const interactiveRef = useRef(false);
  const isDarkStateRef = useRef(true);
  const [state, setState] = useState<"starting" | "ready" | "error">("starting");
  const [error, setError] = useState<string>();
  const [interactive, setInteractive] = useState(false);
  const [editorValue, setEditorValue] = useState("");
  const [interactiveProcess, setInteractiveProcess] = useState<string>();
  const isDarkRef = useTerminalTheme(hostRef, terminalRef);

  useEffect(() => {
    interactiveRef.current = interactive;
  }, [interactive]);

  /**
   * Snap the overlay editor onto xterm's cursor cell and restyle it to
   * match the grid. Runs imperatively (scroll/render/writes) because the
   * caret moves far more often than React state changes.
   */
  const syncEditor = useCallback(() => {
    const textarea = textareaRef.current;
    const terminal = terminalRef.current;
    const wrap = wrapRef.current;
    if (!textarea || !terminal || !wrap) return;

    const buffer = terminal.buffer.active;
    const cursorVisible = buffer.cursorY - buffer.viewportY >= 0 && buffer.cursorY - buffer.viewportY < terminal.rows;
    if (interactiveRef.current || !cursorVisible) {
      textarea.dataset.anchor = "hidden";
      return;
    }
    textarea.dataset.anchor = "visible";

    const xtermEl = hostRef.current?.querySelector<HTMLElement>(".xterm");
    if (!xtermEl) return;
    const wrapRect = wrap.getBoundingClientRect();
    const xtermRect = xtermEl.getBoundingClientRect();
    // Cell metrics live on the internal render service; fall back to the
    // screen element's measured size if the private API shape ever changes.
    /* eslint-disable no-underscore-dangle */
    const renderService = (
      terminal as unknown as {
        _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } } };
      }
    )._core?._renderService;
    /* eslint-enable no-underscore-dangle */
    const cell = renderService?.dimensions?.css?.cell;
    const cellWidth = cell?.width ?? 0;
    const cellHeight = cell?.height ?? 0;
    if (cellWidth <= 0 || cellHeight <= 0) return;

    const row = buffer.cursorY - buffer.viewportY;
    const left = xtermRect.left - wrapRect.left + buffer.cursorX * cellWidth;
    const top = xtermRect.top - wrapRect.top + row * cellHeight;
    const usableWidth = (terminal.cols - buffer.cursorX) * cellWidth;

    textarea.style.left = `${left}px`;
    textarea.style.top = `${top}px`;
    textarea.style.width = `${Math.max(usableWidth, cellWidth * 4)}px`;
    textarea.style.fontSize = `${terminal.options.fontSize ?? 13}px`;
    textarea.style.lineHeight = `${cellHeight}px`;
    textarea.style.fontFamily =
      terminal.options.fontFamily ?? '"SFMono-Regular", "Cascadia Code", "JetBrains Mono", monospace';

    const palette = isDarkStateRef.current ? DARK_PALETTE : LIGHT_PALETTE;
    textarea.style.color = palette.foreground ?? "";
    // Thin bar caret matching the terminal's cursorStyle — never the browser
    // default (which reads as a hollow block against the xterm grid).
    textarea.style.caretColor = palette.cursor ?? "";

    // Auto-size: as many editor rows as the text needs (visual wrap only —
    // the shell receives the command as one logical line).
    textarea.style.height = "0px";
    const needed = Math.min(Math.max(textarea.scrollHeight, cellHeight), cellHeight * 12);
    textarea.style.height = `${needed}px`;
  }, []);

  useEffect(() => {
    isDarkStateRef.current = isDarkRef.current;
    syncEditor();
  }, [isDarkRef, syncEditor]);

  useEffect(() => {
    syncEditor();
  }, [editorValue, interactive, state, syncEditor]);

  const submitEditor = useCallback(() => {
    const id = ptyIdRef.current;
    if (!id) return;
    const value = editorStateRef.current.value;
    const trimmed = value.replace(/\s+$/, "");
    // The shell's own line editor applies continuation rules (heredocs,
    // quotes, trailing backslashes); send the buffer as one paste plus CR.
    window.ePi.sideTerminal.write(id, value.replace(/\r\n/g, "\n") + "\r");
    if (trimmed.length > 0) {
      const history = editorStateRef.current.history;
      if (history[history.length - 1] !== trimmed) history.push(trimmed);
    }
    editorStateRef.current.value = "";
    editorStateRef.current.historyIndex = null;
    setEditorValue("");
  }, []);

  const moveCaretToEnd = useCallback(() => {
    requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (!element) return;
      element.setSelectionRange(element.value.length, element.value.length);
      syncEditor();
    });
  }, [syncEditor]);

  const onEditorKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Never steal keys from an IME composition (CJK input, dead keys): the
      // Enter that commits the candidate must not submit the command.
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        submitEditor();
        return;
      }
      if (event.key === "Escape" && editorStateRef.current.historyIndex !== null) {
        event.preventDefault();
        editorStateRef.current.historyIndex = null;
        editorStateRef.current.value = "";
        setEditorValue("");
        return;
      }
      if (event.key === "ArrowUp" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
        // Only hijack ↑ when the caret is on the first line — moving up
        // through the command's own text stays native.
        const caret = textareaRef.current?.selectionStart ?? 0;
        if (!isCaretOnFirstLine(editorStateRef.current.value, caret)) return;
        if (editorStateRef.current.historyIndex === null && editorStateRef.current.history.length === 0) return;
        event.preventDefault();
        const history = editorStateRef.current.history;
        const nextIndex =
          editorStateRef.current.historyIndex === null
            ? history.length - 1
            : Math.max(0, editorStateRef.current.historyIndex - 1);
        editorStateRef.current.historyIndex = nextIndex;
        editorStateRef.current.value = history[nextIndex];
        setEditorValue(history[nextIndex]);
        moveCaretToEnd();
        return;
      }
      if (event.key === "ArrowDown" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
        if (editorStateRef.current.historyIndex === null) return;
        const value = editorStateRef.current.value;
        const caret = textareaRef.current?.selectionStart ?? value.length;
        if (!isCaretOnLastLine(value, caret)) return;
        event.preventDefault();
        const history = editorStateRef.current.history;
        const nextIndex = editorStateRef.current.historyIndex + 1;
        if (nextIndex >= history.length) {
          editorStateRef.current.historyIndex = null;
          editorStateRef.current.value = "";
          setEditorValue("");
        } else {
          editorStateRef.current.historyIndex = nextIndex;
          editorStateRef.current.value = history[nextIndex];
          setEditorValue(history[nextIndex]);
        }
        moveCaretToEnd();
      }
    },
    [moveCaretToEnd, submitEditor],
  );

  const onEditorChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
    editorStateRef.current.value = event.target.value;
    editorStateRef.current.historyIndex = null;
    setEditorValue(event.target.value);
  }, []);

  const onTerminalClick = useCallback(() => {
    // Only steal focus when the click did not create a selection — a dragged
    // selection must keep the output focused so ⌘C copies it.
    requestAnimationFrame(() => {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      if (interactiveRef.current) terminalRef.current?.focus();
      else textareaRef.current?.focus();
    });
  }, []);

  useEffect(() => {
    let disposed = false;
    let terminal: Terminal | undefined;
    let id: string | undefined;
    let stopData: (() => void) | undefined;
    let inputDisposable: { dispose(): void } | undefined;
    let cursorListener: { dispose(): void } | undefined;
    let scrollListener: { dispose(): void } | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let resizeScheduler: ReturnType<typeof createResizeScheduler> | undefined;
    let unsubscribeAppearance: (() => void) | undefined;
    let eraseScrollbackGuard: { dispose(): void } | undefined;
    let statusTimer: number | undefined;
    let pendingWrites = 0;
    let pendingWriteBytes = 0;

    const setInteractiveMode = (nextInteractive: boolean, processName?: string) => {
      const changed = interactiveRef.current !== nextInteractive;
      if (changed) {
        interactiveRef.current = nextInteractive;
        setInteractive(nextInteractive);
      }
      setInteractiveProcess(processName);
      if (nextInteractive && changed) {
        editorStateRef.current.historyIndex = null;
        editorStateRef.current.value = "";
        setEditorValue("");
      } else if (!nextInteractive && changed) {
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
    };

    const refreshStatus = async () => {
      if (!id || disposed) return;
      try {
        const status = await window.ePi.sideTerminal.status(id);
        if (!status || disposed) return;
        setInteractiveMode(status.interactive, status.foregroundProcess);
      } catch {
        // Status polling is best-effort only; the terminal stays usable.
      }
    };

    const flushWrite = (data: string, onWritten?: () => void) => {
      pendingWrites += 1;
      pendingWriteBytes += data.length;
      terminal!.write(data, () => {
        pendingWrites -= 1;
        pendingWriteBytes -= data.length;
        syncEditor();
        void refreshStatus();
        onWritten?.();
      });
    };

    const start = async () => {
      if (!hostRef.current) return;
      try {
        id = await window.ePi.sideTerminal.spawn(cwd);
        ptyIdRef.current = id;
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
      // The overlay editor owns the caret in line-edit mode; in raw-input
      // mode xterm still has no painted cursor (hollow-block ghosting during
      // mode flips is worse than a caret-only terminal). Programs that need
      // one (vim) draw their own via inverse-video cells.
      terminal.options.cursorStyle = "bar";
      terminal.options.cursorInactiveStyle = "none";
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(hostRef.current);
      terminalRef.current = terminal;
      eraseScrollbackGuard = guardEraseScrollback(terminal);
      // The overlay caret rides on xterm's cursor cell: re-anchor whenever
      // the cursor moves or the viewport scrolls (prompt printing, output,
      // history browsing, resize reflow…).
      cursorListener = terminal.onCursorMove(syncEditor);
      scrollListener = terminal.onScroll(syncEditor);

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
        // Same parser-ordering discipline as the main terminal: resizing while
        // a shell output batch is still queued makes the producer and the
        // emulator disagree about cursor coordinates, so defer the fit until
        // an explicit FIFO barrier behind the current write batch commits.
        hasPendingWrites: () => pendingWrites > 0,
        queueWriteBarrier: (onDrained) => {
          terminal!.write("", () => {
            if (disposed) return;
            onDrained();
          });
        },
        onFitted: ({ cols, rows }) => {
          if (id) window.ePi.sideTerminal.resize(id, { cols, rows });
          syncEditor();
        },
      });
      resizeObserver = new ResizeObserver(() => resizeScheduler!.schedule());
      resizeObserver.observe(hostRef.current);
      resizeScheduler.refitNow();

      unsubscribeAppearance = subscribeAppearance(() => {
        terminal!.options.fontSize = getAppearance().termSide;
        resizeScheduler!.schedule();
        syncEditor();
      });

      stopData = window.ePi.sideTerminal.onData((dataId, data) => {
        if (dataId !== id) return;
        flushWrite(data, primeViewportSync);
      });
      inputDisposable = terminal.onData((data) => {
        // Raw keystrokes only reach the pty while an interactive foreground
        // program owns the tty; otherwise typing happens in the overlay.
        if (interactiveRef.current && id) window.ePi.sideTerminal.write(id, data);
      });
      statusTimer = window.setInterval(() => {
        void refreshStatus();
      }, STATUS_POLL_MS);
      void refreshStatus();
      setState("ready");
      requestAnimationFrame(() => {
        syncEditor();
        textareaRef.current?.focus();
      });
    };

    void start();

    return () => {
      disposed = true;
      if (statusTimer !== undefined) window.clearInterval(statusTimer);
      resizeScheduler?.dispose();
      if (id) window.ePi.sideTerminal.kill(id);
      ptyIdRef.current = undefined;
      stopData?.();
      inputDisposable?.dispose();
      cursorListener?.dispose();
      scrollListener?.dispose();
      resizeObserver?.disconnect();
      terminal?.dispose();
      terminalRef.current = null;
      unsubscribeAppearance?.();
      eraseScrollbackGuard?.dispose();
    };
  }, [cwd, isDarkRef, syncEditor]);

  return (
    <div className="git-panel-body">
      {state === "starting" ? <div className="git-empty-panel">Starting terminal…</div> : null}
      {state === "error" ? <div className="git-error">{error}</div> : null}
      <div
        className="tool-terminal-wrap"
        data-interactive={interactive ? "true" : "false"}
        ref={wrapRef}
        onClick={onTerminalClick}
      >
        <div className="tool-terminal-host" ref={hostRef} aria-label="Embedded terminal output" />
        <textarea
          ref={textareaRef}
          className="tool-terminal-editor"
          data-anchor="hidden"
          value={editorValue}
          onChange={onEditorChange}
          onKeyDown={onEditorKeyDown}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={interactive || state !== "ready"}
          rows={1}
          aria-label="Command editor"
        />
        {interactive ? (
          <div className="tool-terminal-raw-badge" role="status">
            <span className="tool-terminal-raw-dot" aria-hidden="true" />
            {interactiveProcess ?? "interactive"} — raw input, editor resumes after exit
          </div>
        ) : null}
      </div>
    </div>
  );
});
