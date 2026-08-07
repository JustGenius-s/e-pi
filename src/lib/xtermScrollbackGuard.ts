import type { Terminal } from "@xterm/xterm";

/**
 * Suppress "erase scrollback" (`CSI 3 J` / `CSI ? 3 J`) at parse time.
 *
 * The embedded pi TUI emits a full redraw (`ESC[2J ESC[H ESC[3J`) on every
 * authoritative render (PTY resize, panel/layout change, TUI viewport shift).
 * Executing `3J` trims the entire xterm scrollback and clamps `ydisp` toward
 * 0, which yanks a scrolled-up viewport back to the top of the scrollback and
 * destroys the history the user is reading.
 *
 * The previous guard stripped `3J` from the PTY stream at *queue* time, based
 * on the scroll state at that moment. xterm parses writes asynchronously
 * (setTimeout macrotask), so a chunk queued while the viewport was at the
 * bottom could execute after the user scrolled up — that queue/parse race is
 * the "view jumps to the top" bug that survived the old mitigation.
 *
 * Registering a CSI handler moves the decision to *parse* time, exactly when
 * xterm would execute the trim, with the live viewport state, and the parser
 * state machine reassembles sequences split across PTY chunks for us. The
 * sequence is consumed unconditionally:
 *
 * - The viewport can never be yanked to the top by `3J`.
 * - The scrollback survives full redraws, so output the user was reading
 *   stays available. Redraw frames overwrite the visible rows in place (the
 *   `2J` clears them before the repaint), so no stale frames accumulate.
 * - `2J` / `0J` / other erase-display variants are left untouched.
 */
export function guardEraseScrollback(terminal: Terminal): { dispose(): void } {
  const suppress = (params: Array<number | number[]>): boolean => params[0] === 3;
  const plain = terminal.parser.registerCsiHandler({ final: "J" }, suppress);
  // DECSED: `CSI ? Ps J` (private prefix) also reaches the erase-in-display
  // handler and must be suppressed the same way.
  const decsed = terminal.parser.registerCsiHandler({ prefix: "?", final: "J" }, suppress);
  return {
    dispose() {
      plain.dispose();
      decsed.dispose();
    },
  };
}
