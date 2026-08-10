/**
 * Per-session output batching for `runtime:data` IPC.
 *
 * The pty emits ~1KB chunks up to thousands of times per second (measured
 * 2,165 chunks/s under load); forwarding each one as its own IPC message is
 * a serialization + wake-up tax on the renderer. Batch per session: flush on
 * an 8ms timer or at a size cap, whichever comes first. Input (typing echo)
 * is untouched — this only coalesces output.
 *
 * Pure class with injected flush callback, so it is unit-testable without an
 * Electron runtime (see test/output-batcher.test.ts).
 */

export interface OutputBatchOptions {
  /** Max time (ms) a chunk waits for siblings before flush. */
  flushMs?: number;
  /** Flush immediately once a batch reaches this many bytes. */
  sizeCapBytes?: number;
  /** Whether complete synchronized TUI frames bypass the normal 8ms timer. */
  flushSynchronizedFrames?: () => boolean;
}

interface PendingBatch {
  chunks: string[];
  bytes: number;
  syncClosePrefix: string;
  timer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_FLUSH_MS = 8;
const DEFAULT_SIZE_CAP_BYTES = 64 * 1024;
const SYNCHRONIZED_OUTPUT_CLOSE = "\x1b[?2026l";

function markerPrefix(value: string, marker: string): string {
  const maxLength = Math.min(value.length, marker.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = value.slice(-length);
    if (marker.startsWith(suffix)) return suffix;
  }
  return "";
}

export class OutputBatcher {
  readonly #batches = new Map<string, PendingBatch>();
  readonly #onFlush: (sessionPath: string, data: string) => void;
  readonly #flushMs: number;
  readonly #sizeCapBytes: number;
  readonly #flushSynchronizedFrames: () => boolean;

  constructor(onFlush: (sessionPath: string, data: string) => void, options: OutputBatchOptions = {}) {
    this.#onFlush = onFlush;
    this.#flushMs = options.flushMs ?? DEFAULT_FLUSH_MS;
    this.#sizeCapBytes = options.sizeCapBytes ?? DEFAULT_SIZE_CAP_BYTES;
    this.#flushSynchronizedFrames = options.flushSynchronizedFrames ?? (() => true);
  }

  push(sessionPath: string, data: string): void {
    if (!data) return;
    let batch = this.#batches.get(sessionPath);
    if (!batch) {
      batch = { chunks: [], bytes: 0, syncClosePrefix: "" };
      this.#batches.set(sessionPath, batch);
    }
    // Ordering: chunks are pushed in arrival order and joined in the same
    // order, so the renderer always sees a prefix-consistent stream.
    batch.chunks.push(data);
    batch.bytes += data.length;
    const flushSynchronizedFrames = this.#flushSynchronizedFrames();
    const markerInput = flushSynchronizedFrames ? batch.syncClosePrefix + data : "";
    const closesSynchronizedFrame = flushSynchronizedFrames && markerInput.includes(SYNCHRONIZED_OUTPUT_CLOSE);
    batch.syncClosePrefix = flushSynchronizedFrames ? markerPrefix(markerInput, SYNCHRONIZED_OUTPUT_CLOSE) : "";
    // Pi wraps every visual TUI update in synchronized output. Flush as soon
    // as the close marker arrives: intra-frame PTY chunks still coalesce, but
    // a complete frame never waits for the generic 8ms trailing timer.
    if (closesSynchronizedFrame || batch.bytes >= this.#sizeCapBytes) {
      this.flush(sessionPath);
    } else if (batch.timer === undefined) {
      batch.timer = setTimeout(() => this.flush(sessionPath), this.#flushMs);
      batch.timer.unref?.();
    }
  }

  /** Deliver the session's pending batch now (drop the timer). */
  flush(sessionPath: string): void {
    const batch = this.#batches.get(sessionPath);
    if (!batch || batch.chunks.length === 0) return;
    this.#batches.delete(sessionPath);
    if (batch.timer !== undefined) {
      clearTimeout(batch.timer);
      batch.timer = undefined;
    }
    // Single-chunk batches are forwarded without joining (zero copy).
    const data = batch.chunks.length === 1 ? batch.chunks[0] : batch.chunks.join("");
    this.#onFlush(sessionPath, data);
  }

  /** Clear every pending timer. Deliver nothing (process is being discarded). */
  dispose(): void {
    for (const batch of this.#batches.values()) {
      if (batch.timer !== undefined) clearTimeout(batch.timer);
    }
    this.#batches.clear();
  }
}
