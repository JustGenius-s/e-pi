import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";

import {
  encodeResizeFrameMarker,
  FULLSCREEN_REDRAW_PREFIX,
  inspectResizeFrameMetadata,
  RESIZE_FRAME_MARKER_PREFIX,
  RESIZE_FRAME_MARKER_TERMINATOR,
} from "../src/lib/terminalResizeProtocol";

describe("terminal resize frame protocol", () => {
  it("round-trips an exact fullscreen grid", () => {
    const marker = encodeResizeFrameMarker({ cols: 132, rows: 41 });
    const checkpoint = `${FULLSCREEN_REDRAW_PREFIX}${marker}content`;

    expect(marker.endsWith(RESIZE_FRAME_MARKER_TERMINATOR)).toBe(true);
    expect(inspectResizeFrameMetadata(checkpoint)).toEqual({
      status: "tagged",
      size: { cols: 132, rows: 41 },
    });
  });

  it("terminates the APC marker before plain leading text reaches xterm", async () => {
    const terminal = new Terminal({ cols: 40, rows: 5 });

    await new Promise<void>((resolve) => {
      terminal.write(`${encodeResizeFrameMarker({ cols: 40, rows: 5 })}plain`, resolve);
    });

    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("plain");
    terminal.dispose();
  });

  it("keeps waiting while the private APC marker is split", () => {
    expect(inspectResizeFrameMetadata(FULLSCREEN_REDRAW_PREFIX)).toEqual({ status: "pending" });
    expect(inspectResizeFrameMetadata(`${FULLSCREEN_REDRAW_PREFIX}${RESIZE_FRAME_MARKER_PREFIX.slice(0, 7)}`)).toEqual({
      status: "pending",
    });
    expect(inspectResizeFrameMetadata(`${FULLSCREEN_REDRAW_PREFIX}${RESIZE_FRAME_MARKER_PREFIX}120x`)).toEqual({
      status: "pending",
    });
  });

  it("accepts legacy untagged checkpoints and rejects malformed tagged ones", () => {
    expect(inspectResizeFrameMetadata(`${FULLSCREEN_REDRAW_PREFIX}line`)).toEqual({ status: "untagged" });
    expect(
      inspectResizeFrameMetadata(
        `${FULLSCREEN_REDRAW_PREFIX}${RESIZE_FRAME_MARKER_PREFIX}bad${RESIZE_FRAME_MARKER_TERMINATOR}line`,
      ),
    ).toEqual({ status: "invalid" });
  });
});
