import { useEffect, useState } from "react";

import type { PiRuntimeState } from "../../../types/contracts";

/** Same braille spinner frames as pi-tui's Loader (default 80ms interval). */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Map a 6-dot braille char onto the left two columns of a 3x3 grid:
 * dot 1-3 -> column 0 (rows 0-2), dot 4-6 -> column 1 (rows 0-2)
 * Returns 9 booleans, row-major. The third column stays off, so the spinner
 * and the done/error square share the same 3x3 canvas and dot size.
 */
function braillePattern(character: string): boolean[] {
  const bits = (character.codePointAt(0) ?? 0x2800) - 0x2800;
  const indexOfDot: Record<number, number> = { 1: 0, 2: 3, 3: 6, 4: 1, 5: 4, 6: 7 };
  const pattern = new Array<boolean>(9).fill(false);
  for (let dot = 1; dot <= 6; dot++) {
    if (bits & (1 << (dot - 1))) pattern[indexOfDot[dot]!] = true;
  }
  return pattern;
}

const ALL_DOTS_ON = Array.from({ length: 9 }, () => true);
/** Fixed grid positions so keys are stable and independent of array indices. */
const DOT_POSITIONS = [0, 1, 2, 3, 4, 5, 6, 7, 8];

/** 3x3 dot-matrix canvas; lit dots inherit the parent's color. */
function DotMatrix({ pattern }: { pattern: boolean[] }) {
  return (
    <span className="session-activity-matrix" aria-hidden="true">
      {DOT_POSITIONS.map((position) => (
        <i key={position} data-on={pattern[position] ? "true" : undefined} />
      ))}
    </span>
  );
}

/** Blue braille spinner rendered on the same 3x3 canvas as the squares. */
function ActivitySpinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((current) => (current + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="session-activity working" title="Working…" aria-label="Working…">
      <DotMatrix pattern={braillePattern(SPINNER_FRAMES[frame]!)} />
    </span>
  );
}

interface ActivityIndicatorProps {
  runtime?: PiRuntimeState;
}

/**
 * Per-session status glyph shown before the session title:
 * - working (process running, agent busy): blue braille spinner
 * - done (process running, agent settled): green dot-matrix square
 * - error: red dot-matrix square
 * - every other state: an invisible 12px placeholder
 *
 * The placeholder keeps the row grid at three columns — status, title
 * (1fr, ellipsized), time (auto). Without it a row with no status has only
 * two children, so the title lands in the auto column and the time in the
 * 1fr track, where a long title squeezes it to zero width.
 */
export function ActivityIndicator({ runtime }: ActivityIndicatorProps) {
  const working = runtime?.status === "running" && runtime.activity === "busy";
  const done = runtime?.status === "running" && runtime.activity === "idle";
  const failed = runtime?.status === "error";

  if (working) {
    return <ActivitySpinner />;
  }
  if (failed) {
    return (
      <span className="session-activity error" title="Runtime error" aria-label="Runtime error">
        <DotMatrix pattern={ALL_DOTS_ON} />
      </span>
    );
  }
  if (done) {
    return (
      <span className="session-activity done" title="Idle" aria-label="Idle">
        <DotMatrix pattern={ALL_DOTS_ON} />
      </span>
    );
  }
  return <span className="session-activity" aria-hidden="true" />;
}
