export const PI_VIEWPORT_OSC_ID = 6973;

const PI_VIEWPORT_PAYLOAD_PREFIX = "e-pi:viewport:v1;";
const PI_VIEWPORT_WHEEL_MAX_LINES = 9_999;
const PI_VIEWPORT_WHEEL_MAX_COORDINATE = 99_999;

export const PI_SCROLL_TO_BOTTOM_INPUT = "\x1b_e-pi:viewport:bottom\x1b\\";

export interface PiViewportState {
  scrollTop: number;
  maxScrollTop: number;
  followingEnd: boolean;
}

export interface PiViewportCellGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
  columns: number;
  rows: number;
}

export interface PiViewportCell {
  x: number;
  y: number;
}

interface PiViewportWheelBatcherOptions {
  write: (input: string) => void;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
}

export interface PiViewportWheelBatcher {
  push(deltaRows: number, x: number, y: number): void;
  dispose(): void;
}

export function encodePiViewportStatePayload(state: PiViewportState): string {
  return `${PI_VIEWPORT_PAYLOAD_PREFIX}${state.scrollTop};${state.maxScrollTop};${state.followingEnd ? 1 : 0}`;
}

/** Decode the authoritative application-owned viewport emitted by Pi fullscreen mode. */
export function decodePiViewportStatePayload(payload: string): PiViewportState | null {
  if (!payload.startsWith(PI_VIEWPORT_PAYLOAD_PREFIX)) return null;

  const match = /^(0|[1-9]\d*);(0|[1-9]\d*);([01])$/.exec(payload.slice(PI_VIEWPORT_PAYLOAD_PREFIX.length));
  if (!match) return null;

  const scrollTop = Number(match[1]);
  const maxScrollTop = Number(match[2]);
  if (!Number.isSafeInteger(scrollTop) || !Number.isSafeInteger(maxScrollTop) || scrollTop > maxScrollTop) return null;

  const followingEnd = match[3] === "1";
  if (followingEnd && scrollTop !== maxScrollTop) return null;
  return { scrollTop, maxScrollTop, followingEnd };
}

/** Encode an exact, coordinate-aware scroll command for Pi fullscreen mode. */
export function encodePiViewportWheelInput(lines: number, x: number, y: number): string {
  const validLines = Number.isSafeInteger(lines) && lines !== 0 && Math.abs(lines) <= PI_VIEWPORT_WHEEL_MAX_LINES;
  const validX = Number.isSafeInteger(x) && x >= 0 && x <= PI_VIEWPORT_WHEEL_MAX_COORDINATE;
  const validY = Number.isSafeInteger(y) && y >= 0 && y <= PI_VIEWPORT_WHEEL_MAX_COORDINATE;
  if (!validLines || !validX || !validY) throw new RangeError("Invalid Pi viewport wheel command");
  return `\x1b_e-pi:viewport:wheel:v1;${lines};${x};${y}\x1b\\`;
}

/** Convert browser wheel units to terminal rows without xterm's small-delta attenuation. */
export function wheelDeltaToTerminalRows(
  deltaY: number,
  deltaMode: number,
  cellHeight: number,
  viewportRows: number,
): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
  if (deltaMode === 1) return deltaY;
  if (deltaMode === 2) return deltaY * Math.max(1, viewportRows);
  if (deltaMode !== 0 || !Number.isFinite(cellHeight) || cellHeight <= 0) return 0;
  const rows = deltaY / cellHeight;
  // A normal trackpad sample often lands just below one rendered row. Snap
  // that range to one row so quantization does not create periodic 32 ms
  // stalls; genuinely small momentum samples still accumulate precisely.
  if (Math.abs(rows) >= 0.5 && Math.abs(rows) < 1) return Math.sign(rows);
  return rows;
}

/** Map a DOM pointer position to the terminal cell used by Pi's nested ScrollView routing. */
export function getPiViewportCell(
  clientX: number,
  clientY: number,
  geometry: PiViewportCellGeometry,
): PiViewportCell | null {
  const values = [
    clientX,
    clientY,
    geometry.left,
    geometry.top,
    geometry.width,
    geometry.height,
    geometry.columns,
    geometry.rows,
  ];
  if (values.some((value) => !Number.isFinite(value))) return null;
  if (geometry.width <= 0 || geometry.height <= 0 || geometry.columns < 1 || geometry.rows < 1) return null;

  const x = Math.floor(((clientX - geometry.left) / geometry.width) * geometry.columns);
  const y = Math.floor(((clientY - geometry.top) / geometry.height) * geometry.rows);
  return {
    x: Math.max(0, Math.min(geometry.columns - 1, x)),
    y: Math.max(0, Math.min(geometry.rows - 1, y)),
  };
}

/** Coalesce high-frequency trackpad samples into at most one exact Pi scroll per animation frame. */
export function createPiViewportWheelBatcher(options: PiViewportWheelBatcherOptions): PiViewportWheelBatcher {
  const requestFrame = options.requestFrame ?? ((callback) => requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
  let pendingRows = 0;
  let pendingX = 0;
  let pendingY = 0;
  let frame: number | undefined;
  let disposed = false;

  const flush = (): boolean => {
    if (disposed) return false;
    const wholeRows = Math.sign(pendingRows) * Math.floor(Math.abs(pendingRows) + 0.5);
    const lines = Math.max(-PI_VIEWPORT_WHEEL_MAX_LINES, Math.min(PI_VIEWPORT_WHEEL_MAX_LINES, wholeRows));
    if (lines === 0) return false;
    pendingRows -= lines;
    options.write(encodePiViewportWheelInput(lines, pendingX, pendingY));
    return true;
  };
  const unlockOnNextFrame = () => {
    frame = undefined;
    if (flush()) frame = requestFrame(unlockOnNextFrame);
  };

  return {
    push(deltaRows, x, y) {
      if (disposed || !Number.isFinite(deltaRows) || deltaRows === 0) return;
      pendingRows += deltaRows;
      pendingX = Math.max(0, Math.min(PI_VIEWPORT_WHEEL_MAX_COORDINATE, Math.trunc(x)));
      pendingY = Math.max(0, Math.min(PI_VIEWPORT_WHEEL_MAX_COORDINATE, Math.trunc(y)));
      if (frame === undefined) {
        flush();
        // The first whole-row movement is latency-sensitive and leaves
        // immediately. Further samples in this display frame are coalesced.
        frame = requestFrame(unlockOnNextFrame);
      }
    },
    dispose() {
      disposed = true;
      pendingRows = 0;
      if (frame !== undefined) cancelFrame(frame);
      frame = undefined;
    },
  };
}
