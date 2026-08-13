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
  /** Editor buffer stashed while an interactive program owns the tty. */
  suspendedValue?: string;
}

const STATUS_POLL_MS = 400;
/**
 * Re-anchor cadence for the overlay caret. Cursor-move/scroll events fire
 * while xterm's parser still has queued chunks, so the observed cursor cell
 * is frequently mid-burst (echo typing redraws the prompt several times per
 * keystroke). A light interval reads the settled geometry instead.
 */
const ANCHOR_POLL_MS = 45;
/** Hold the previous anchor while a screen clear (ED 2) scrolls content. */
const ANCHOR_HOLD_CLEAR_MS = 700;

/**
 * Map a keydown to the byte sequence a real terminal would send for it.
 * Returns undefined for keys with no terminal meaning (pure modifiers,
 * browser-chord shortcuts the app keeps). Used while the shell owns the
 * line (post-completion), where every keystroke is forwarded to ZLE.
 */
function keyToTerminalSequence(event: React.KeyboardEvent<HTMLTextAreaElement>): string | undefined {
  const { key } = event;
  if (event.ctrlKey && !event.metaKey && !event.altKey && key.length === 1) {
    const code = key.toLowerCase().charCodeAt(0);
    if (code >= 97 && code <= 122) return String.fromCharCode(code - 96); // ^A..^Z
  }
  if (event.altKey && !event.ctrlKey && !event.metaKey && key.length === 1) {
    return `\x1b${key}`; // meta-chars: \x1bb, \x1bf, …
  }
  if (event.metaKey || event.ctrlKey) return undefined; // app shortcuts stay local
  const named: Record<string, string> = {
    ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D",
    Home: "\x1b[H", End: "\x1b[F", Delete: "\x1b[3~", Backspace: "\x7f",
    PageUp: "\x1b[5~", PageDown: "\x1b[6~",
  };
  if (event.altKey && (key === "ArrowLeft" || key === "ArrowRight")) {
    return key === "ArrowLeft" ? "\x1bb" : "\x1bf";
  }
  if (named[key]) return named[key];
  if (key.length === 1) return key; // printable
  return undefined;
}

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
  /**
   * True after a Tab completion hands the command line to the shell: the
   * completed text lives on the shell's ZLE line (the overlay can't read it
   * back), so further keystrokes are forwarded raw until the line submits or
   * is aborted. Keeps the overlay and the shell from editing divergent lines.
   */
  const shellOwnsLineRef = useRef(false);
  const isDarkStateRef = useRef(true);
  /** Timestamp of the last observed full-screen clear (prompt redraw). */
  const lastClearRef = useRef(0);
  /** Frozen anchor geometry during a clear-hold window. */
  const holdAnchorRef = useRef<{ left: number; top: number } | null>(null);
  /** Last applied anchor position, reused while the hold window runs. */
  const lastAnchorRef = useRef<{ left: number; top: number } | null>(null);
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
    // cursorY is SCREEN-relative (0..rows-1); viewportY/baseY are ABSOLUTE
    // buffer lines. The cursor's absolute line is baseY + cursorY; its row on
    // screen is that minus the viewport's top line. (cursorY - viewportY
    // mixes the two spaces and goes wildly negative once scrollback exists.)
    const cursorRow = buffer.baseY + buffer.cursorY - buffer.viewportY;
    const cursorVisible = cursorRow >= 0 && cursorRow < terminal.rows;
    if (interactiveRef.current || !cursorVisible) {
      textarea.dataset.anchor = "hidden";
      return;
    }

    // A shell prompt redraw (zsh-autosuggest accept, fzf close, `clear`) often
    // clears the screen and reprints the prompt at the same viewport row; the
    // reflow between "cleared" and "reprinted" makes the buffer row read as
    // somewhere inside the content. Freeze the caret on its last anchor for a
    // short window so it never jumps into the output area.
    const holding = lastClearRef.current > 0 && Date.now() - lastClearRef.current < ANCHOR_HOLD_CLEAR_MS;
    const hold = holding ? holdAnchorRef.current ?? lastAnchorRef.current : null;
    if (hold) {
      textarea.dataset.anchor = "visible";
      textarea.style.left = `${hold.left}px`;
      textarea.style.top = `${hold.top}px`;
      return;
    }
    lastClearRef.current = 0;
    holdAnchorRef.current = null;
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

    const left = xtermRect.left - wrapRect.left + buffer.cursorX * cellWidth;
    const top = xtermRect.top - wrapRect.top + cursorRow * cellHeight;
    const usableWidth = (terminal.cols - buffer.cursorX) * cellWidth;

    textarea.style.left = `${left}px`;
    textarea.style.top = `${top}px`;
    lastAnchorRef.current = { left, top };
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
    shellOwnsLineRef.current = false;
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
  /** Latest moveCaretToEnd, for the mount-effect closure (deps stay [cwd]). */
  const moveCaretToEndRef = useRef(moveCaretToEnd);
  useEffect(() => {
    moveCaretToEndRef.current = moveCaretToEnd;
  }, [moveCaretToEnd]);

  const onEditorKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Never steal keys from an IME composition (CJK input, dead keys): the
      // Enter that commits the candidate must not submit the command.
      if (event.nativeEvent.isComposing) return;

      // Shell line-editor passthrough: while the editor is empty the overlay
      // is just a caret riding on the prompt, so keys the shell understands
      // (Tab completion, ↑/↓ history, word jumps, ^A/^E/^U/^K/^W/^R, …) are
      // forwarded to the pty and the shell redraws them. Once the editor
      // holds text, typing stays local until Enter submits.
      const forward = (data: string): void => {
        const id = ptyIdRef.current;
        if (id) window.ePi.sideTerminal.write(id, data);
      };

      // Completion passthrough: after Tab handed the line to the shell, every
      // keystroke goes straight to ZLE (it owns the completed text; the
      // overlay stays empty). Submit/abort returns ownership to the overlay.
      if (shellOwnsLineRef.current) {
        if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
          event.preventDefault();
          shellOwnsLineRef.current = false;
          forward("\r");
          return;
        }
        if (event.key === "Escape" || (event.ctrlKey && event.key.toLowerCase() === "c")) {
          event.preventDefault();
          shellOwnsLineRef.current = false;
          forward(event.key === "Escape" ? "\x1b" : "\x03");
          return;
        }
        if (event.metaKey && event.key.toLowerCase() === "c") {
          const selection = window.getSelection();
          if (selection && !selection.isCollapsed) return; // copy wins
          event.preventDefault();
          shellOwnsLineRef.current = false;
          forward("\x03");
          return;
        }
        if (event.key === "Tab" && !event.metaKey && !event.ctrlKey) {
          event.preventDefault();
          forward(event.shiftKey ? "\x1b[Z" : "\t");
          return;
        }
        // Forward the key as its terminal byte sequence: printable chars,
        // arrows, backspace/delete, and the ^X control map all go to ZLE.
        const sequence = keyToTerminalSequence(event);
        if (sequence) {
          event.preventDefault();
          forward(sequence);
        }
        return;
      }

      const editorEmpty = editorStateRef.current.value.length === 0;
      const bare = !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
      // Tab must NEVER fall through to the browser: inside a terminal it is
      // completion, not focus traversal. Gate only on meta/ctrl (those are app
      // shortcuts).
      if (event.key === "Tab" && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        if (event.shiftKey) {
          forward("\x1b[Z"); // reverse menu-complete, no prefix needed
          return;
        }
        // The overlay holds its text LOCALLY; the shell's line is empty until
        // Enter. Completing against an empty zsh line makes expand-or-complete
        // fall back to self-insert — a literal tab (the "indent" the user
        // saw). Hand the current text to the shell first so completion has a
        // prefix, then trigger it. The completed line now belongs to the
        // shell (it redraws the prompt with the result), so the local editor
        // is cleared and the caret follows the redrawn line.
        const pending = editorStateRef.current.value;
        if (pending.length > 0) {
          editorStateRef.current.value = "";
          editorStateRef.current.historyIndex = null;
          setEditorValue("");
          shellOwnsLineRef.current = true;
          forward(pending.replace(/\r?\n/g, " ") + "\t");
        } else {
          forward("\t");
        }
        return;
      }
      if (event.key === "ArrowUp" && editorEmpty && bare) {
        event.preventDefault();
        forward("\x1b[A");
        return;
      }
      if (event.key === "ArrowDown" && editorEmpty && bare) {
        event.preventDefault();
        forward("\x1b[B");
        return;
      }
      if (event.key === "ArrowLeft" && event.altKey && editorEmpty) {
        event.preventDefault();
        forward("\x1bb");
        return;
      }
      if (event.key === "ArrowRight" && event.altKey && editorEmpty) {
        event.preventDefault();
        forward("\x1bf");
        return;
      }
      const CONTROL_SEQUENCES: Record<string, string> = {
        a: "\x01", b: "\x02", d: "\x04", e: "\x05", f: "\x06", h: "\x08",
        k: "\x0b", l: "\x0c", n: "\x0e", p: "\x10", r: "\x12", t: "\x14",
        u: "\x15", w: "\x17",
      };
      if (event.ctrlKey && !event.metaKey && !event.altKey) {
        const sequence = CONTROL_SEQUENCES[event.key.toLowerCase()];
        if (sequence && (editorEmpty || event.key.toLowerCase() === "c")) {
          event.preventDefault();
          forward(sequence);
          return;
        }
      }
      if (event.metaKey && event.key.toLowerCase() === "c") {
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed) return; // copy wins
        event.preventDefault();
        forward("\x03");
        return;
      }
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
      // Boundary passthrough (arrows/backspace/delete) only applies to a
      // COLLAPSED caret. With an active selection the browser's native
      // behaviour must run: checking only selectionStart misreads a selection
      // that starts at 0 as "caret at line start", so Backspace got
      // preventDefault'd and the forwarded \x7f hit the shell's empty line —
      // the selection never deleted.
      const selectionStart = textareaRef.current?.selectionStart ?? 0;
      const selectionEnd = textareaRef.current?.selectionEnd ?? selectionStart;
      const hasSelection = selectionStart !== selectionEnd;
      if (event.key === "Backspace" || event.key === "Delete") {
        // TEMP DIAGNOSTIC: confirm whether selection-delete reaches this code.
        console.log("[side-term del]", {
          key: event.key, selectionStart, selectionEnd, hasSelection,
          value: editorStateRef.current.value, shellOwns: shellOwnsLineRef.current,
          editorEmpty: editorStateRef.current.value.length === 0,
        });
      }
      if (event.key === "ArrowLeft" && bare) {
        if (!hasSelection && selectionStart === 0) {
          event.preventDefault();
          forward("\x1b[D");
          return;
        }
      }
      if (event.key === "ArrowRight" && bare) {
        if (!hasSelection && selectionStart >= editorStateRef.current.value.length) {
          event.preventDefault();
          forward("\x1b[C");
          return;
        }
      }
      if (event.key === "Backspace" && bare) {
        if (!hasSelection && selectionStart === 0) {
          event.preventDefault();
          forward("\x7f");
          return;
        }
      }
      if (event.key === "Delete" && bare) {
        if (!hasSelection && selectionStart >= editorStateRef.current.value.length) {
          event.preventDefault();
          forward("\x1b[3~");
          return;
        }
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
    // Any local edit means the overlay owns the line again (IME, paste, or a
    // char that bypassed the passthrough map) — leave completion mode.
    shellOwnsLineRef.current = false;
    editorStateRef.current.value = event.target.value;
    editorStateRef.current.historyIndex = null;
    setEditorValue(event.target.value);
    const id = ptyIdRef.current;
    if (id) window.ePi.sideTerminal.write(id, "\x1b>"); // zsh: end-of-history
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
    let resizeObserver: ResizeObserver | undefined;
    let resizeScheduler: ReturnType<typeof createResizeScheduler> | undefined;
    let unsubscribeAppearance: (() => void) | undefined;
    let eraseScrollbackGuard: { dispose(): void } | undefined;
    let statusTimer: number | undefined;
    let anchorTimer: number | undefined;
    let pendingWrites = 0;
    let pendingWriteBytes = 0;

    const setInteractiveMode = (nextInteractive: boolean, processName?: string) => {
      const changed = interactiveRef.current !== nextInteractive;
      if (changed) {
        interactiveRef.current = nextInteractive;
        setInteractive(nextInteractive);
        // The shell's echo/icanon mode must match who owns the line editing:
        // raw while the overlay edits, sane while the tty is in raw input.
        if (id) window.ePi.sideTerminal.setEditorMode(id, !nextInteractive);
      }
      setInteractiveProcess(processName);
      if (nextInteractive && changed) {
        editorStateRef.current.historyIndex = null;
        editorStateRef.current.suspendedValue = editorStateRef.current.value;
        editorStateRef.current.value = "";
        setEditorValue("");
      } else if (!nextInteractive && changed) {
        const restore = editorStateRef.current.suspendedValue ?? "";
        editorStateRef.current.suspendedValue = undefined;
        editorStateRef.current.value = restore;
        setEditorValue(restore);
        requestAnimationFrame(() => {
          textareaRef.current?.focus();
          moveCaretToEndRef.current();
        });
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
      // ED 2 (full-screen erase) marks a prompt redraw cycle (zsh-autosuggest
      // accept, fzf close, `clear`). Arm the anchor hold BEFORE xterm parses
      // the chunk so the caret never follows the buffer's mid-reflow row.
      const erase = "\x1b[";
      if (data.includes(`${erase}2J`) || data.includes(`${erase}3J`) || data.includes(`${erase}H${erase}J`)) {
        lastClearRef.current = Date.now();
        holdAnchorRef.current = lastAnchorRef.current;
      }
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
      // The overlay starts out owning line editing: quiet the kernel echo
      // before the shell's first prompt can double-paint typed glyphs.
      window.ePi.sideTerminal.setEditorMode(id, true);

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
      // The overlay caret rides on xterm's cursor cell. Cursor-move/scroll
      // events fire mid-parse (before the output batch settles — a prompt
      // redraw parks the cursor inside content for several chunks), so the
      // anchor is maintained by a light poll of the settled geometry instead.
      anchorTimer = window.setInterval(syncEditor, ANCHOR_POLL_MS);

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
      if (anchorTimer !== undefined) window.clearInterval(anchorTimer);
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
