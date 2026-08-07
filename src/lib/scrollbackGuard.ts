/**
 * Strips "erase scrollback" (CSI Ps J with Ps = 3) from a PTY stream.
 *
 * The embedded pi TUI emits a full redraw (`ESC[2J ESC[H ESC[3J`) on every
 * authoritative render. `3J` makes xterm trim the entire scrollback and reset
 * `ydisp` to 0 — which yanks the viewport back to the top if the user is
 * currently scrolled up in history. When the user is following output (at the
 * bottom) the trim is invisible and should be kept: it is what keeps stale
 * TUI frames from accumulating in the scrollback. So the guard only strips
 * `3J` while the viewport is NOT at the bottom.
 *
 * PTY chunks can split an escape sequence anywhere, so the guard carries an
 * unfinished CSI prefix across calls. Non-CSI content (including OSC
 * sequences, which xterm's own parser reassembles) is passed through
 * untouched.
 */

/** `ESC[3J`, `ESC[?3J`, and parameter-list variants whose first param is 3. */
// eslint-disable-next-line no-control-regex -- deliberate ESC-byte match for VT sequences.
const CSI_ERASE_SCROLLBACK = /\u001b\[\??3(?:;[0-9]*)?J/g;
/** Tail that could be the start of a CSI sequence split across chunks. */
// eslint-disable-next-line no-control-regex -- deliberate ESC-byte match for VT sequences.
const CSI_PREFIX_TAIL = /\u001b(?:\[\??[0-9;]*)?$/;

export class ScrollbackGuard {
  private carry = "";

  /**
   * @param data The next PTY chunk (UTF-8 string).
   * @param protect Strip `3J` when true; pass the stream through when false.
   */
  transform(data: string, protect: boolean): string {
    if (!data) return "";
    const input = this.carry + data;
    this.carry = "";
    if (!protect) return input;

    if (!input.includes("\x1b")) return input;
    const stripped = input.replace(CSI_ERASE_SCROLLBACK, "");

    // A chunk can end in the middle of a CSI sequence. Hold the unfinished
    // prefix back so the next chunk can be inspected as one stream; emitting
    // it one chunk later is harmless.
    const tailMatch = stripped.match(CSI_PREFIX_TAIL);
    if (tailMatch && tailMatch[0].length > 0) {
      this.carry = tailMatch[0];
      return stripped.slice(0, -this.carry.length);
    }
    return stripped;
  }
}
