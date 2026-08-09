import { appendTerminalReplay, createAwaitingCheckpointBuffer, replayContent } from "./terminalReplayBuffer";
import type { TerminalReplayBuffer } from "./terminalReplayBuffer";

/**
 * Replay buffers per session, kept across terminal unmount/remount
 * (switching to another session destroys the xterm instance). A hidden
 * session keeps accumulating output in the background via the app-lifetime
 * feeder, so switching back replays the latest self-contained TUI frame plus
 * subsequent output. Obsolete full-redraw frames are compacted instead of
 * replayed.
 *
 * Bounded by `maxBufferedSessions` (LRU): sessions not touched in a while are
 * evicted so a long-running multi-session app does not retain an unbounded
 * number of multi-megabyte terminal snapshots.
 * An evicted session's terminal still works — the checkpoint-recovery shimmy
 * forces pi to repaint a full frame on the next pty resize.
 */

const MAX_BUFFERED_SESSIONS = 6;
/**
 * Sessions evicted from the replay cache, newest first (FIFO). When a session
 * is evicted its buffer is dropped, but the session's process may still be
 * running and producing output. Without a buffer the terminal remounts empty
 * AND `isAwaitingCheckpoint` would be false, so the checkpoint-recovery
 * shimmy never fires and the terminal stays blank until the next manual
 * resize. Keeping a bounded marker here makes the remount force a full
 * redraw (see TerminalPanel).
 */
const MAX_EVICTED_SESSIONS = 12;

/** Insertion order is LRU order: Map guarantees iteration = insertion order. */
const buffers = new Map<string, TerminalReplayBuffer>();
const evictedSessions = new Map<string, true>();

let maxBufferedSessions = MAX_BUFFERED_SESSIONS;

function recordEviction(sessionKey: string): void {
  evictedSessions.delete(sessionKey);
  evictedSessions.set(sessionKey, true);
  while (evictedSessions.size > MAX_EVICTED_SESSIONS) {
    const oldest = evictedSessions.keys().next();
    if (oldest.done) break;
    evictedSessions.delete(oldest.value);
  }
}

export function appendTerminalBuffer(sessionKey: string, data: string): void {
  let previous = buffers.get(sessionKey);
  if (!previous && evictedSessions.has(sessionKey)) {
    // The buffer was evicted but the process is still live: resume in
    // checkpoint-waiting state so the stream is never replayed mid-frame.
    previous = createAwaitingCheckpointBuffer();
  }
  const next = appendTerminalReplay(previous, data);
  // Output arrived: the session is live again, so a remount can replay it.
  evictedSessions.delete(sessionKey);
  // Re-insert at the end to mark this session as most recently used.
  buffers.delete(sessionKey);
  buffers.set(sessionKey, next);
  while (buffers.size > maxBufferedSessions) {
    const oldest = buffers.keys().next();
    if (oldest.done || oldest.value === sessionKey) break;
    buffers.delete(oldest.value);
    recordEviction(oldest.value);
  }
}

export function getReplayContent(sessionKey: string): string {
  return replayContent(buffers.get(sessionKey));
}

/**
 * Whether the session's replay stream is awaiting a full redraw checkpoint.
 * True for buffers invalidated by overflow, and for sessions whose buffer
 * was LRU-evicted while their process kept running.
 */
export function isAwaitingCheckpoint(sessionKey: string): boolean {
  return buffers.get(sessionKey)?.awaitingCheckpoint ?? evictedSessions.has(sessionKey);
}

export function clearTerminalBuffer(sessionKey: string): void {
  buffers.delete(sessionKey);
  evictedSessions.delete(sessionKey);
}

/** Test hook: shrink/restore the LRU cap. */
export function setMaxBufferedSessions(value: number): void {
  maxBufferedSessions = value;
  while (buffers.size > maxBufferedSessions) {
    const oldest = buffers.keys().next();
    if (oldest.done) break;
    buffers.delete(oldest.value);
    recordEviction(oldest.value);
  }
}
