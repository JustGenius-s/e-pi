import { appendTerminalReplay, createAwaitingCheckpointBuffer, replayContent } from "./terminalReplayBuffer";
import type { TerminalReplayBuffer } from "./terminalReplayBuffer";
import { inspectResizeFrameMetadata } from "./terminalResizeProtocol";
import type { TerminalGridSize } from "./terminalResizeProtocol";

export type ResizeGateCancelResult = "idle" | "flushed" | "needs-checkpoint";

export interface TerminalResizeOutputGate {
  /** Freeze visible output while xterm locally reflows the current picture. */
  begin(): void;
  /** Drop old-size output and wait for pi's next authoritative full frame. */
  commit(options?: ResizeGateCommitOptions): void;
  /** The grid returned to its PTY size; replay buffered output if it is safe. */
  cancel(): ResizeGateCancelResult;
  /** Route one live PTY chunk through the current gate phase. */
  push(data: string): void;
  isActive(): boolean;
  dispose(): void;
}

export interface TerminalResizeOutputGateOptions {
  write: (data: string, onWritten?: () => void) => void;
  onCheckpointRecovered?: () => void;
  onCheckpointSkipped?: () => void;
  onCheckpointRejected?: (actual: TerminalGridSize | undefined, expected: TerminalGridSize) => void;
}

export interface ResizeGateCommitOptions {
  /** Accept only a tagged full frame produced for this exact grid. */
  expectedSize?: TerminalGridSize;
  /** Intentionally parse and hide this many matching frames first. */
  skipCompleteFrames?: number;
}

type GatePhase = "idle" | "resizing" | "awaiting-checkpoint" | "streaming-checkpoint";
const SYNC_CLOSE_SEQUENCE = "\x1b[?2026l";
const MAX_HELD_OLD_SIZE_OUTPUT = 400_000;

function markerPrefix(value: string, marker: string): string {
  const maxLength = Math.min(value.length, marker.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = value.slice(-length);
    if (marker.startsWith(suffix)) return suffix;
  }
  return "";
}

/**
 * Keep old-size PTY output away from an xterm that is previewing a new grid.
 *
 * Old-size output is bounded while xterm locally reflows. After the final PTY
 * resize, the gate waits for pi's next full-redraw marker, then streams that
 * synchronized frame into xterm instead of buffering the whole thing. The
 * visual guard keeps the previous complete canvas above xterm until the write
 * containing `CSI ? 2026 l` has parsed, so multi-megabyte frames remain atomic
 * without a frame-sized JavaScript allocation or a fixed-size overflow trap.
 */
export function createTerminalResizeOutputGate(options: TerminalResizeOutputGateOptions): TerminalResizeOutputGate {
  let phase: GatePhase = "idle";
  let buffered: TerminalReplayBuffer | undefined;
  let completeFramesToSkip = 0;
  let expectedSize: TerminalGridSize | undefined;
  let checkpointClosePrefix = "";
  let checkpointGeneration = 0;
  let disposed = false;

  const becomeIdle = (): void => {
    phase = "idle";
    buffered = undefined;
    completeFramesToSkip = 0;
    expectedSize = undefined;
    checkpointClosePrefix = "";
  };

  const sameSize = (left: TerminalGridSize, right: TerminalGridSize): boolean =>
    left.cols === right.cols && left.rows === right.rows;

  const rejectCheckpoint = (actual: TerminalGridSize | undefined): void => {
    phase = "awaiting-checkpoint";
    buffered = createAwaitingCheckpointBuffer();
    checkpointClosePrefix = "";
    if (expectedSize) options.onCheckpointRejected?.(actual, expectedSize);
  };

  const finishCheckpoint = (generation: number): void => {
    if (disposed || phase !== "streaming-checkpoint" || generation !== checkpointGeneration) return;
    if (completeFramesToSkip > 0) {
      completeFramesToSkip -= 1;
      phase = "awaiting-checkpoint";
      buffered = createAwaitingCheckpointBuffer();
      checkpointClosePrefix = "";
      options.onCheckpointSkipped?.();
      return;
    }
    becomeIdle();
    options.onCheckpointRecovered?.();
  };

  const streamCheckpoint = (data: string): void => {
    const generation = checkpointGeneration;
    const markerInput = checkpointClosePrefix + data;
    const closesCheckpoint = markerInput.includes(SYNC_CLOSE_SEQUENCE);
    checkpointClosePrefix = markerPrefix(markerInput, SYNC_CLOSE_SEQUENCE);
    options.write(data, closesCheckpoint ? () => finishCheckpoint(generation) : undefined);
  };

  return {
    begin() {
      if (disposed || phase === "resizing") return;
      checkpointGeneration += 1;
      phase = "resizing";
      // If a second resize begins before the previous authoritative frame
      // parses, its completion callback is stale. New bytes are held for the
      // latest transaction while already-queued parser writes drain in order.
      buffered = undefined;
      completeFramesToSkip = 0;
      expectedSize = undefined;
      checkpointClosePrefix = "";
    },

    commit(commitOptions = {}) {
      if (disposed) return;
      checkpointGeneration += 1;
      phase = "awaiting-checkpoint";
      buffered = createAwaitingCheckpointBuffer();
      completeFramesToSkip = Math.max(0, commitOptions.skipCompleteFrames ?? 0);
      expectedSize = commitOptions.expectedSize;
      checkpointClosePrefix = "";
    },

    cancel(): ResizeGateCancelResult {
      if (disposed || phase === "idle") return "idle";
      if (phase === "awaiting-checkpoint" || phase === "streaming-checkpoint") {
        return "needs-checkpoint";
      }

      const pending = buffered;
      if (pending?.awaitingCheckpoint) {
        checkpointGeneration += 1;
        phase = "awaiting-checkpoint";
        buffered = createAwaitingCheckpointBuffer();
        checkpointClosePrefix = "";
        return "needs-checkpoint";
      }

      const data = replayContent(pending);
      becomeIdle();
      if (data) options.write(data);
      return "flushed";
    },

    push(data: string) {
      if (disposed || !data) return;
      if (phase === "idle") {
        options.write(data);
        return;
      }
      if (phase === "streaming-checkpoint") {
        streamCheckpoint(data);
        return;
      }

      // Old-size incremental output is disposable and stays tightly bounded.
      // Checkpoint discovery is different: the chunk containing the redraw
      // marker is immediately handed to xterm, so it must not inherit either
      // the replay-store cap or this temporary resize buffer cap.
      const maxBufferedChars = phase === "resizing" ? MAX_HELD_OLD_SIZE_OUTPUT : Number.MAX_SAFE_INTEGER;
      buffered = appendTerminalReplay(buffered, data, maxBufferedChars);
      if (phase !== "awaiting-checkpoint" || buffered.awaitingCheckpoint) return;

      const checkpoint = replayContent(buffered);
      const metadata = inspectResizeFrameMetadata(checkpoint);
      if (metadata.status === "pending") return;
      // A resize transaction is fail-closed: without an exact bridge tag we
      // cannot prove this full frame belongs to the latest PTY grid. Legacy
      // untagged frames remain accepted only when no size was requested.
      if (metadata.status === "invalid" || (metadata.status === "untagged" && expectedSize)) {
        rejectCheckpoint(undefined);
        return;
      }
      if (metadata.status === "tagged" && expectedSize && !sameSize(metadata.size, expectedSize)) {
        rejectCheckpoint(metadata.size);
        return;
      }
      buffered = undefined;
      phase = "streaming-checkpoint";
      streamCheckpoint(checkpoint);
    },

    isActive() {
      return phase !== "idle";
    },

    dispose() {
      disposed = true;
      checkpointGeneration += 1;
      becomeIdle();
    },
  };
}
