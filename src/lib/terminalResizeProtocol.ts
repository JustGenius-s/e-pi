export interface TerminalGridSize {
  cols: number;
  rows: number;
}

/** TuiAltScreen's first row clear in a full synchronized redraw. */
export const FULLSCREEN_REDRAW_PREFIX = "\x1b[?2026h\x1b[2J\x1b[1;1H\x1b[2K";

/**
 * Private APC metadata emitted by E-Pi's bridge immediately after the full
 * redraw prefix. APC is ignored by xterm, so the marker never occupies a cell.
 */
export const RESIZE_FRAME_MARKER_PREFIX = "\x1b_e-pi:frame:";
/** APC strings terminate with ST; BEL is only a valid short terminator for OSC. */
export const RESIZE_FRAME_MARKER_TERMINATOR = "\x1b\\";

export type ResizeFrameMetadata =
  | { status: "pending" }
  | { status: "untagged" }
  | { status: "invalid" }
  | { status: "tagged"; size: TerminalGridSize };

export function encodeResizeFrameMarker({ cols, rows }: TerminalGridSize): string {
  return `${RESIZE_FRAME_MARKER_PREFIX}${cols}x${rows}${RESIZE_FRAME_MARKER_TERMINATOR}`;
}

/**
 * Inspect a buffered full-redraw checkpoint without waiting for the whole
 * frame. The bridge puts metadata directly after the fixed redraw prefix, so
 * only a few bytes must be held before the frame can be accepted or rejected.
 */
export function inspectResizeFrameMetadata(checkpoint: string): ResizeFrameMetadata {
  const redrawAt = checkpoint.lastIndexOf(FULLSCREEN_REDRAW_PREFIX);
  if (redrawAt < 0) return { status: "untagged" };

  const metadata = checkpoint.slice(redrawAt + FULLSCREEN_REDRAW_PREFIX.length);
  if (!metadata) return { status: "pending" };
  if (RESIZE_FRAME_MARKER_PREFIX.startsWith(metadata)) return { status: "pending" };
  if (!metadata.startsWith(RESIZE_FRAME_MARKER_PREFIX)) return { status: "untagged" };

  const terminatorAt = metadata.indexOf(RESIZE_FRAME_MARKER_TERMINATOR, RESIZE_FRAME_MARKER_PREFIX.length);
  if (terminatorAt < 0) return { status: "pending" };

  const payload = metadata.slice(RESIZE_FRAME_MARKER_PREFIX.length, terminatorAt);
  const match = /^([1-9]\d*)x([1-9]\d*)$/.exec(payload);
  if (!match) return { status: "invalid" };

  const cols = Number(match[1]);
  const rows = Number(match[2]);
  if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows)) return { status: "invalid" };
  return { status: "tagged", size: { cols, rows } };
}
