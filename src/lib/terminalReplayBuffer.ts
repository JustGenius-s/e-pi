/**
 * Pi's TUI emits a full-screen reset before every authoritative redraw.
 * Keeping output before the latest reset only replays obsolete frames when a
 * session terminal is remounted, and can surface old spinner frames as rows.
 */
const SYNC_OPEN_SEQUENCE = "\x1b[?2026h";
const SYNC_CLOSE_SEQUENCE = "\x1b[?2026l";
const FULL_REDRAW_SEQUENCE = "\x1b[2J\x1b[H\x1b[3J";

export const DEFAULT_TERMINAL_REPLAY_LIMIT = 400_000;

export interface TerminalReplayBuffer {
  /** Self-contained VT stream that is safe to feed to a fresh xterm parser. */
  content: string;
  /** Overflow invalidated the stream; ignore data until a full redraw arrives. */
  awaitingCheckpoint: boolean;
  /** Bounded suffix used only to recognize a redraw marker split across chunks. */
  checkpointPrefix: string;
}

const EMPTY_REPLAY: TerminalReplayBuffer = {
  content: "",
  awaitingCheckpoint: false,
  checkpointPrefix: "",
};

function checkpointPrefixOf(value: string): string {
  const maxLength = Math.min(value.length, FULL_REDRAW_SEQUENCE.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = value.slice(-length);
    if (FULL_REDRAW_SEQUENCE.startsWith(suffix)) return suffix;
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
  const clearAt = value.lastIndexOf(FULL_REDRAW_SEQUENCE);
  if (clearAt < 0) return undefined;

  const openAt = value.lastIndexOf(SYNC_OPEN_SEQUENCE, clearAt);
  const closeAt = value.lastIndexOf(SYNC_CLOSE_SEQUENCE, clearAt);
  if (openAt > closeAt) return value.slice(openAt);
  return SYNC_OPEN_SEQUENCE + value.slice(clearAt);
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
  const previous = current ?? EMPTY_REPLAY;
  if (!data) return previous;
  if (maxChars <= 0) {
    return { content: "", awaitingCheckpoint: true, checkpointPrefix: checkpointPrefixOf(data) };
  }

  const input = previous.awaitingCheckpoint ? previous.checkpointPrefix + data : previous.content + data;
  const checkpoint = latestCheckpoint(input);

  if (checkpoint !== undefined && checkpoint.length <= maxChars) {
    return { content: checkpoint, awaitingCheckpoint: false, checkpointPrefix: "" };
  }

  if (!previous.awaitingCheckpoint && checkpoint === undefined && input.length <= maxChars) {
    return { content: input, awaitingCheckpoint: false, checkpointPrefix: "" };
  }

  // Either the incremental stream overflowed or even its latest checkpoint is
  // too large. Starting at the next chunk could begin inside CSI/OSC/UTF-8, so
  // stay invalid and retain only a bounded marker prefix for recovery.
  return {
    content: "",
    awaitingCheckpoint: true,
    checkpointPrefix: checkpointPrefixOf(input),
  };
}
