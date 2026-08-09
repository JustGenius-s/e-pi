/**
 * Pi's TUI emits a full-screen reset before every authoritative redraw.
 * Keeping output before the latest reset only replays obsolete frames when a
 * session terminal is remounted, and can surface old spinner frames as rows.
 */
const SYNC_OPEN_SEQUENCE = "\x1b[?2026h";
const SYNC_CLOSE_SEQUENCE = "\x1b[?2026l";
const MAIN_SCREEN_FULL_REDRAW_SEQUENCE = "\x1b[2J\x1b[H\x1b[3J";
// TuiAltScreen follows its full clear with an absolute row-1 cursor move and
// line clear. Including that suffix disambiguates it from TuiMainScreen,
// whose frame starts with the same `SYNC_OPEN + CSI 2 J` prefix before
// continuing with `CSI H + CSI 3 J`.
const ALT_SCREEN_FULL_REDRAW_SEQUENCE = `${SYNC_OPEN_SEQUENCE}\x1b[2J\x1b[1;1H\x1b[2K`;
/** Modes established by TuiAltScreen.beforeTerminalStart(). */
const ALT_SCREEN_REPLAY_PROLOGUE =
  "\x1b[?1049h\x1b[?7l\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h\x1b[?25l";
const CHECKPOINT_MARKERS = [MAIN_SCREEN_FULL_REDRAW_SEQUENCE, ALT_SCREEN_FULL_REDRAW_SEQUENCE] as const;
const MAX_CHECKPOINT_MARKER_LENGTH = Math.max(...CHECKPOINT_MARKERS.map((marker) => marker.length));

// A long agent transcript can produce a multi-megabyte authoritative redraw
// even at a modest 80x36 grid. Keep enough headroom for the measured ~4.6MB
// frame so switching sessions can replay it directly instead of forcing a
// recovery resize. Live resize checkpoints stream independently of this cap.
export const DEFAULT_TERMINAL_REPLAY_LIMIT = 8_000_000;

export interface TerminalReplayBuffer {
  /** Self-contained VT stream that is safe to feed to a fresh xterm parser. */
  readonly content: string;
  /** Overflow invalidated the stream; ignore data until a full redraw arrives. */
  readonly awaitingCheckpoint: boolean;
  /** Bounded suffix used only to recognize a redraw marker split across chunks. */
  readonly checkpointPrefix: string;
}

/**
 * Internal storage. The public `content` is a lazy getter over these segments,
 * so appending a chunk never copies the whole buffer (the previous design
 * concatenated the entire replay on every chunk — measured ~77µs/chunk at a
 * 108KB steady state, i.e. a continuous main-thread tax while pi streams).
 */
interface BufferState {
  segments: string[];
  length: number;
  /** Lazily materialized `segments.join("")`; invalidated on append. */
  joined: string | undefined;
}

const states = new WeakMap<TerminalReplayBuffer, BufferState>();

function makeBuffer(awaitingCheckpoint: boolean, checkpointPrefix: string, state?: BufferState): TerminalReplayBuffer {
  const innerState: BufferState = state ?? { segments: [], length: 0, joined: undefined };
  const buffer: TerminalReplayBuffer = {
    get content(): string {
      innerState.joined ??= innerState.segments.join("");
      return innerState.joined;
    },
    awaitingCheckpoint,
    checkpointPrefix,
  };
  states.set(buffer, innerState);
  return buffer;
}

const EMPTY_REPLAY: TerminalReplayBuffer = makeBuffer(false, "");

/**
 * Zero-content buffer that demands a full redraw checkpoint before replay.
 * Used for sessions whose replay cache entry was LRU-evicted while the
 * process stayed alive: their stream is incomplete, so replaying it could
 * surface a partial frame — wait for the next authoritative redraw instead.
 */
export function createAwaitingCheckpointBuffer(): TerminalReplayBuffer {
  return makeBuffer(true, "");
}

/** Last up to `count` characters of the accumulated stream, without joining. */
function tailChars(state: BufferState, count: number): string {
  let result = "";
  for (let i = state.segments.length - 1; i >= 0 && result.length < count; i -= 1) {
    const segment = state.segments[i];
    const take = Math.min(segment.length, count - result.length);
    result = segment.slice(segment.length - take) + result;
  }
  return result;
}

function checkpointPrefixOf(value: string): string {
  const maxLength = Math.min(value.length, MAX_CHECKPOINT_MARKER_LENGTH - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = value.slice(-length);
    if (CHECKPOINT_MARKERS.some((marker) => marker.startsWith(suffix))) return suffix;
  }
  return "";
}

/**
 * Turn the latest full redraw into a stream that is safe for a new terminal.
 * Normally the producer's synchronized-output opener is retained. If it was
 * in an older/discarded chunk, synthesize one so the retained closing marker
 * is balanced and the replay remains atomic.
 */
function latestCheckpoint(value: string): string | undefined {
  const mainClearAt = value.lastIndexOf(MAIN_SCREEN_FULL_REDRAW_SEQUENCE);
  const altOpenAt = value.lastIndexOf(ALT_SCREEN_FULL_REDRAW_SEQUENCE);

  // A regular frame also begins with `SYNC_OPEN + CSI 2 J`; prefer its more
  // specific main-screen marker when both candidates refer to the same frame.
  const mainOpenAt = mainClearAt < 0 ? -1 : value.lastIndexOf(SYNC_OPEN_SEQUENCE, mainClearAt);
  const mainCloseAt = mainClearAt < 0 ? -1 : value.lastIndexOf(SYNC_CLOSE_SEQUENCE, mainClearAt);
  const mainFrameAt = mainOpenAt > mainCloseAt ? mainOpenAt : mainClearAt;

  if (altOpenAt >= 0 && altOpenAt > mainFrameAt) {
    return ALT_SCREEN_REPLAY_PROLOGUE + value.slice(altOpenAt);
  }
  if (mainClearAt < 0) return undefined;

  if (mainOpenAt > mainCloseAt) return value.slice(mainOpenAt);
  return SYNC_OPEN_SEQUENCE + value.slice(mainClearAt);
}

function appendIntoExisting(previous: TerminalReplayBuffer, data: string, maxChars: number): TerminalReplayBuffer {
  const state = states.get(previous)!;

  // Invalid state: only the bounded marker prefix plus this chunk can contain
  // the checkpoint that recovers the stream. Everything else is discarded
  // (mirrors the original semantics exactly).
  if (previous.awaitingCheckpoint) {
    const input = previous.checkpointPrefix + data;
    const checkpoint = latestCheckpoint(input);
    if (checkpoint !== undefined && checkpoint.length <= maxChars) {
      return makeBuffer(false, "", { segments: [checkpoint], length: checkpoint.length, joined: undefined });
    }
    return makeBuffer(true, checkpointPrefixOf(input));
  }

  const newLength = state.length + data.length;
  // A fresh full redraw can only live entirely inside `data` or straddle the
  // segment/data boundary — a full redraw older than the last 10 chars was
  // already checkpointed away. So a bounded window suffices; no full scan.
  const boundaryWindow = tailChars(state, MAX_CHECKPOINT_MARKER_LENGTH - 1) + data;
  if (newLength <= maxChars && !CHECKPOINT_MARKERS.some((marker) => boundaryWindow.includes(marker))) {
    state.segments.push(data);
    state.length = newLength;
    state.joined = undefined;
    return previous;
  }

  // Slow path: a checkpoint arrived, or the stream overflowed. Both are rare
  // (pi only re-emits a full frame on pty resize/layout change), so joining
  // the whole buffer here is acceptable.
  const input = (state.joined ?? state.segments.join("")) + data;
  const checkpoint = latestCheckpoint(input);
  if (checkpoint !== undefined && checkpoint.length <= maxChars) {
    return makeBuffer(false, "", { segments: [checkpoint], length: checkpoint.length, joined: undefined });
  }

  // Defensive parity with the original implementation (unreachable when the
  // boundary window above matched, kept for byte-exact behavior).
  if (checkpoint === undefined && input.length <= maxChars) {
    return makeBuffer(false, "", { segments: [input], length: input.length, joined: undefined });
  }

  // Either the incremental stream overflowed or even its latest checkpoint is
  // too large. Starting at the next chunk could begin inside CSI/OSC/UTF-8, so
  // stay invalid and retain only a bounded marker prefix for recovery.
  // The prefix only depends on the stream tail, which `boundaryWindow` covers.
  return makeBuffer(true, checkpointPrefixOf(boundaryWindow));
}

/**
 * Append PTY output without ever retaining half of a VT/UTF-8 stream. The
 * latest full-redraw frame is an authoritative checkpoint, so older frames
 * can be discarded safely. After overflow, all continuation chunks are
 * ignored until such a checkpoint is observed.
 */
export function appendTerminalReplay(
  current: TerminalReplayBuffer | undefined,
  data: string,
  maxChars = DEFAULT_TERMINAL_REPLAY_LIMIT,
): TerminalReplayBuffer {
  if (!data) return current ?? EMPTY_REPLAY;
  if (maxChars <= 0) {
    return makeBuffer(true, checkpointPrefixOf(data));
  }
  if (!current) {
    // Fresh buffer: data alone decides the initial state.
    const buffer = makeBuffer(false, "");
    return appendIntoExisting(buffer, data, maxChars);
  }
  return appendIntoExisting(current, data, maxChars);
}

/** Materialize the buffered stream as a single self-contained VT string. */
export function replayContent(buffer: TerminalReplayBuffer | undefined): string {
  if (!buffer) return "";
  const state = states.get(buffer)!;
  state.joined ??= state.segments.join("");
  return state.joined;
}
