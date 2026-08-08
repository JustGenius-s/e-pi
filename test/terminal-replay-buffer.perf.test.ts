import { describe, expect, it } from "vitest";

import { appendTerminalReplay, DEFAULT_TERMINAL_REPLAY_LIMIT, replayContent } from "../src/lib/terminalReplayBuffer";
import type { TerminalReplayBuffer } from "../src/lib/terminalReplayBuffer";

const SYNC_OPEN = "\x1b[?2026h";
const SYNC_CLOSE = "\x1b[?2026l";
const FULL_REDRAW = "\x1b[2J\x1b[H\x1b[3J";

/**
 * The original (pre-segmentation) implementation, kept verbatim as the
 * reference oracle. The segmented rewrite must produce byte-identical state
 * for every input sequence.
 */
function referenceAppend(
  current: TerminalReplayBuffer | undefined,
  data: string,
  maxChars = DEFAULT_TERMINAL_REPLAY_LIMIT,
): TerminalReplayBuffer {
  const previous = current ?? { content: "", awaitingCheckpoint: false, checkpointPrefix: "" };
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

  return {
    content: "",
    awaitingCheckpoint: true,
    checkpointPrefix: checkpointPrefixOf(input),
  };

  function checkpointPrefixOf(value: string): string {
    const maxLength = Math.min(value.length, FULL_REDRAW.length - 1);
    for (let length = maxLength; length > 0; length -= 1) {
      const suffix = value.slice(-length);
      if (FULL_REDRAW.startsWith(suffix)) return suffix;
    }
    return "";
  }

  function latestCheckpoint(value: string): string | undefined {
    const clearAt = value.lastIndexOf(FULL_REDRAW);
    if (clearAt < 0) return undefined;
    const openAt = value.lastIndexOf(SYNC_OPEN, clearAt);
    const closeAt = value.lastIndexOf(SYNC_CLOSE, clearAt);
    if (openAt > closeAt) return value.slice(openAt);
    return SYNC_OPEN + value.slice(clearAt);
  }
}

/** Deterministic PRNG so failures are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A realistic pi TUI full frame. */
function frame(n: number): string {
  let out = SYNC_OPEN + FULL_REDRAW;
  for (let r = 0; r < 36; r += 1) {
    out += `\x1b[${r + 1};1H\x1b[38;5;245m` + `row ${r} of frame ${n} `.padEnd(110, ".") + "\x1b[0m";
  }
  return out + SYNC_CLOSE;
}

/** A spinner-style incremental update (what streams between full frames). */
function spinner(n: number): string {
  return SYNC_OPEN + `\x1b[36;1H\x1b[38;5;213mworking ${"|/-\\"[n % 4]} ${n}\x1b[0m` + SYNC_CLOSE;
}

describe("appendTerminalReplay cross-validation (segmented vs original)", () => {
  it("produces byte-identical state across randomized chunk sequences", () => {
    const rand = mulberry32(20260701);
    const pick = <T>(values: T[]): T => values[Math.floor(rand() * values.length)];

    // Chunk vocabulary: frames, spinners, plain text, and every possible
    // split of a full-redraw sequence across two chunks.
    const pieces = [
      ...Array.from({ length: 8 }, (_, i) => frame(i)),
      ...Array.from({ length: 20 }, (_, i) => spinner(i)),
      `tool result line ${rand()}`,
      "plain incremental text\n",
      "\x1b[38;2;100;120;140mcolored\x1b[0m",
      "obsolete frame content that should be discarded ",
    ];
    for (let splitAt = 1; splitAt < FULL_REDRAW.length; splitAt += 1) {
      pieces.push(FULL_REDRAW.slice(0, splitAt));
      pieces.push(FULL_REDRAW.slice(splitAt));
    }

    const maxChars = 500;
    let reference: TerminalReplayBuffer | undefined;
    let candidate: TerminalReplayBuffer | undefined;

    for (let step = 0; step < 2000; step += 1) {
      const piece = pick(pieces);
      // Sometimes deliver the split-redraw halves back to back, sometimes
      // with unrelated chunks in between.
      const data = rand() < 0.3 ? `${piece}${pick(pieces)}` : piece;

      reference = referenceAppend(reference, data, maxChars);
      candidate = appendTerminalReplay(candidate, data, maxChars);

      const referenceState = {
        content: reference.content,
        awaitingCheckpoint: reference.awaitingCheckpoint,
        checkpointPrefix: reference.checkpointPrefix,
      };
      const candidateState = {
        content: replayContent(candidate),
        awaitingCheckpoint: candidate.awaitingCheckpoint,
        checkpointPrefix: candidate.checkpointPrefix,
      };
      expect(candidateState, `diverged at step ${step} with data ${JSON.stringify(data)}`).toEqual(referenceState);
    }
  });

  it("matches the original on realistic frame/spinner streams", () => {
    let reference: TerminalReplayBuffer | undefined;
    let candidate: TerminalReplayBuffer | undefined;
    for (let i = 0; i < 40; i += 1) {
      reference = referenceAppend(reference, frame(i));
      candidate = appendTerminalReplay(candidate, frame(i));
    }
    for (let i = 0; i < 2000; i += 1) {
      reference = referenceAppend(reference, spinner(i));
      candidate = appendTerminalReplay(candidate, spinner(i));
    }
    expect(replayContent(candidate)).toBe(reference!.content);
    expect(candidate!.awaitingCheckpoint).toBe(reference!.awaitingCheckpoint);
    expect(candidate!.checkpointPrefix).toBe(reference!.checkpointPrefix);
  });
});

describe("appendTerminalReplay performance", () => {
  it("keeps per-chunk cost bounded regardless of buffer size", () => {
    // Reach a steady state near the real cap with full frames + spinners.
    let buffer: TerminalReplayBuffer | undefined;
    for (let i = 0; i < 40; i += 1) buffer = appendTerminalReplay(buffer, frame(i));
    for (let i = 0; i < 2000; i += 1) buffer = appendTerminalReplay(buffer, spinner(i));
    expect(replayContent(buffer).length).toBeGreaterThan(50_000);

    const N = 3000;
    const start = performance.now();
    for (let i = 0; i < N; i += 1) buffer = appendTerminalReplay(buffer, spinner(i));
    const elapsed = performance.now() - start;

    // The old implementation measured ~77µs/chunk at this steady state
    // (230ms for 3000). The segmented one lands in the low µs; allow a wide
    // CI-safety margin while still catching a regression to linear copies.
    expect(elapsed).toBeLessThan(60);
    expect(elapsed / N).toBeLessThan(0.02); // 20µs/chunk ceiling
  });
});
