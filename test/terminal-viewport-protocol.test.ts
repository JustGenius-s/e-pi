import { Container, ScrollView, TuiAltScreen, VStack } from "@earendil-works/pi-tui";
import type { Terminal } from "@earendil-works/pi-tui/dist/terminal.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createPiViewportWheelBatcher,
  decodePiNavPayload,
  decodePiViewportStatePayload,
  encodePiScrollToRowInput,
  encodePiViewportWheelInput,
  encodePiViewportStatePayload,
  getPiViewportCell,
  PI_SCROLL_TO_BOTTOM_INPUT,
  wheelDeltaToTerminalRows,
} from "../src/lib/terminalViewportProtocol";

class SingleLineBlock {
  constructor(private readonly label: string) {}

  render(): string[] {
    return [this.label];
  }

  invalidate(): void {}
}

class FakeTerminal implements Terminal {
  readonly writes: string[] = [];
  columns = 40;
  rows = 8;
  kittyProtocolActive = false;
  private onInput: ((data: string) => void) | undefined;

  start(onInput: (data: string) => void): void {
    this.onInput = onInput;
  }

  emitInput(data: string): void {
    this.onInput?.(data);
  }

  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data);
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

function viewportPayload(output: string): string {
  const prefix = "\x1b]6973;";
  const start = output.lastIndexOf(prefix);
  const end = start < 0 ? -1 : output.indexOf("\x07", start + prefix.length);
  if (start < 0 || end < 0) throw new Error("Pi viewport OSC payload missing");
  return output.slice(start + prefix.length, end);
}

beforeEach(() => {
  process.env.E_PI_TUI_OPTIMIZATIONS = "true";
});

afterEach(() => {
  delete process.env.E_PI_TUI_OPTIMIZATIONS;
});

describe("Pi fullscreen viewport protocol", () => {
  it("keeps stock pi-tui wheel behavior and emits no E-Pi viewport OSC while disabled", () => {
    process.env.E_PI_TUI_OPTIMIZATIONS = "false";
    const terminal = new FakeTerminal();
    const document = new Container();
    for (let index = 0; index < 48; index += 1) document.addChild(new SingleLineBlock(`line-${index}`));
    const scrollView = new ScrollView(document, { follow: "end", primary: true });
    const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
    tui.setLayoutRoot(scrollView);
    tui.start();
    tui.renderNow();

    expect(terminal.writes.at(-1)).not.toContain("\x1b]6973;");
    expect(scrollView.scrollTop).toBe(40);
    terminal.emitInput("\x1b[<64;1;1M");
    tui.renderNow();
    expect(scrollView.scrollTop).toBe(39);
    tui.stop({ preserveScreen: true });
  });

  it("round-trips valid states and rejects malformed or contradictory states", () => {
    const payload = encodePiViewportStatePayload({ scrollTop: 12, maxScrollTop: 40, followingEnd: false });
    expect(decodePiViewportStatePayload(payload)).toEqual({ scrollTop: 12, maxScrollTop: 40, followingEnd: false });
    expect(decodePiViewportStatePayload("e-pi:viewport:v1;40;40;1")).toEqual({
      scrollTop: 40,
      maxScrollTop: 40,
      followingEnd: true,
    });
    expect(decodePiViewportStatePayload("e-pi:viewport:v1;12;10;0")).toBeNull();
    expect(decodePiViewportStatePayload("e-pi:viewport:v1;12;40;1")).toBeNull();
    expect(decodePiViewportStatePayload("other;12;40;0")).toBeNull();
  });

  it("encodes exact wheel commands and converts browser wheel geometry", () => {
    expect(encodePiViewportWheelInput(-7, 12, 5)).toBe("\x1b_e-pi:viewport:wheel:v1;-7;12;5\x1b\\");
    expect(() => encodePiViewportWheelInput(0, 12, 5)).toThrow(RangeError);
    expect(() => encodePiViewportWheelInput(1, -1, 5)).toThrow(RangeError);

    expect(wheelDeltaToTerminalRows(18, 0, 18, 40)).toBe(1);
    expect(wheelDeltaToTerminalRows(10, 0, 18, 40)).toBe(1);
    expect(wheelDeltaToTerminalRows(4, 0, 18, 40)).toBeCloseTo(2 / 9);
    expect(wheelDeltaToTerminalRows(-3, 1, 18, 40)).toBe(-3);
    expect(wheelDeltaToTerminalRows(1, 2, 18, 40)).toBe(40);
    expect(wheelDeltaToTerminalRows(5, 9, 18, 40)).toBe(0);

    const geometry = { left: 10, top: 20, width: 800, height: 400, columns: 80, rows: 40 };
    expect(getPiViewportCell(415, 225, geometry)).toEqual({ x: 40, y: 20 });
    expect(getPiViewportCell(-100, 1_000, geometry)).toEqual({ x: 0, y: 39 });
  });

  it("coalesces fractional trackpad movement into one exact command per frame", () => {
    const writes: string[] = [];
    const frames: Array<() => void> = [];
    const batcher = createPiViewportWheelBatcher({
      write: (input) => writes.push(input),
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: () => undefined,
    });

    batcher.push(0.3, 4, 2);
    batcher.push(0.3, 8, 3);
    expect(frames).toHaveLength(1);
    expect(writes).toEqual([]);
    frames.shift()!();
    expect(writes).toEqual([encodePiViewportWheelInput(1, 8, 3)]);

    batcher.push(-2.5, 9, 4);
    frames.shift()!();
    expect(writes.at(-1)).toBe(encodePiViewportWheelInput(-3, 9, 4));

    frames.shift()!();
    batcher.push(0.9, 10, 5);
    expect(writes.at(-1)).toBe(encodePiViewportWheelInput(1, 10, 5));
    batcher.dispose();
  });

  it("reports the authoritative viewport, scrolls three lines per wheel event, and consumes scroll-to-bottom", () => {
    const terminal = new FakeTerminal();
    const document = new Container();
    for (let index = 0; index < 48; index += 1) document.addChild(new SingleLineBlock(`line-${index}`));
    const scrollView = new ScrollView(document, { follow: "end", primary: true });
    const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
    tui.setLayoutRoot(scrollView);
    tui.start();
    tui.renderNow();

    expect(decodePiViewportStatePayload(viewportPayload(terminal.writes.at(-1)!))).toEqual({
      scrollTop: 40,
      maxScrollTop: 40,
      followingEnd: true,
    });

    terminal.emitInput("\x1b[<64;1;1M");
    tui.renderNow();
    expect(decodePiViewportStatePayload(viewportPayload(terminal.writes.at(-1)!))).toEqual({
      scrollTop: 37,
      maxScrollTop: 40,
      followingEnd: false,
    });

    terminal.emitInput(encodePiViewportWheelInput(-7, 0, 0));
    tui.renderNow();
    expect(decodePiViewportStatePayload(viewportPayload(terminal.writes.at(-1)!))).toEqual({
      scrollTop: 30,
      maxScrollTop: 40,
      followingEnd: false,
    });

    terminal.emitInput(PI_SCROLL_TO_BOTTOM_INPUT);
    tui.renderNow();
    expect(decodePiViewportStatePayload(viewportPayload(terminal.writes.at(-1)!))).toEqual({
      scrollTop: 40,
      maxScrollTop: 40,
      followingEnd: true,
    });

    tui.stop({ preserveScreen: true });
  });

  it("routes exact wheel lines to the deepest ScrollView under the pointer", () => {
    const terminal = new FakeTerminal();
    const innerDocument = new Container();
    const primaryDocument = new Container();
    for (let index = 0; index < 20; index += 1) innerDocument.addChild(new SingleLineBlock(`inner-${index}`));
    for (let index = 0; index < 30; index += 1) primaryDocument.addChild(new SingleLineBlock(`primary-${index}`));
    const inner = new ScrollView(innerDocument, { follow: "end", overscroll: "contain" });
    const primary = new ScrollView(primaryDocument, { follow: "end", primary: true });
    const root = new VStack([
      { component: inner, basis: 4, grow: 0, shrink: 0, minSize: 4 },
      { component: primary, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    ]);
    const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
    tui.setLayoutRoot(root);
    tui.start();
    tui.renderNow();

    expect(inner.scrollTop).toBe(16);
    expect(primary.scrollTop).toBe(26);
    terminal.emitInput(encodePiViewportWheelInput(-5, 2, 1));
    tui.renderNow();
    expect(inner.scrollTop).toBe(11);
    expect(primary.scrollTop).toBe(26);

    terminal.emitInput(encodePiViewportWheelInput(-4, 2, 6));
    tui.renderNow();
    expect(inner.scrollTop).toBe(11);
    expect(primary.scrollTop).toBe(22);
    tui.stop({ preserveScreen: true });
  });

  it("emits the navigator OSC and jumps to a user-message block on scrollto input", async () => {
    const terminal = new FakeTerminal();
    const document = new Container();
    // Enough blocks for virtualization; mark two as user messages.
    const blocks: SingleLineBlock[] = [];
    for (let index = 0; index < 48; index += 1) {
      const block = new SingleLineBlock(`line-${index}`);
      blocks.push(block);
      document.addChild(block);
    }
    const scrollView = new ScrollView(document, { follow: "end", primary: true });
    const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
    tui.setLayoutRoot(scrollView);
    // What InteractiveMode does for each UserMessageComponent.
    (tui as unknown as { ePiNavBlocks: unknown[] }).ePiNavBlocks = [blocks[5], blocks[20]];
    (tui as unknown as { ePiNavLabels: string[] }).ePiNavLabels = ["fix the login bug", "add a nav rail; with semicolons"];
    tui.start();
    tui.renderNow();

    const navPayload = (output: string): string => {
      const prefix = "\x1b]6974;";
      const start = output.lastIndexOf(prefix);
      const end = start < 0 ? -1 : output.indexOf("\x07", start + prefix.length);
      if (start < 0 || end < 0) throw new Error("Pi nav OSC payload missing");
      return output.slice(start + prefix.length, end);
    };

    const entries = decodePiNavPayload(navPayload(terminal.writes.at(-1)!));
    expect(entries?.length).toBe(2);
    expect(entries?.[0]).toMatchObject({ row: 1, label: "fix the login bug" });
    // semicolons are replaced with spaces by the emitter
    expect(entries?.[1]?.label).toBe("add a nav rail  with semicolons");
    expect(entries![1]!.offset).toBeGreaterThan(entries![0]!.offset);

    // Click row 2 → viewport smooth-scrolls to the second user message block.
    terminal.emitInput(encodePiScrollToRowInput(2));
    // The jump is animated (~16ms frames); drive renders until it settles.
    for (let frame = 0; frame < 40 && scrollView.scrollTop !== entries![1]!.offset; frame += 1) {
      await new Promise((resolve) => setTimeout(resolve, 16));
      tui.renderNow();
    }
    expect(scrollView.scrollTop).toBe(entries![1]!.offset);
    expect(scrollView.isFollowingEnd).toBe(false);

    // Unknown rows are consumed without moving.
    terminal.emitInput(encodePiScrollToRowInput(9));
    tui.renderNow();
    expect(scrollView.scrollTop).toBe(entries![1]!.offset);

    tui.stop({ preserveScreen: true });
  });

  it("encodes and decodes nav protocol primitives", () => {
    expect(encodePiScrollToRowInput(1)).toBe("\x1b_e-pi:viewport:scrollto:v1;1\x1b\\");
    expect(() => encodePiScrollToRowInput(0)).toThrow(RangeError);
    expect(decodePiNavPayload("e-pi:nav:v1;")).toEqual([]);
    expect(decodePiNavPayload("e-pi:nav:v1;12,hello world;40,second")).toEqual([
      { row: 1, offset: 12, label: "hello world", reply: "" },
      { row: 2, offset: 40, label: "second", reply: "" },
    ]);
    expect(decodePiNavPayload("e-pi:nav:v1;12,fix the bug|I checked the code and it;40,second|")).toEqual([
      { row: 1, offset: 12, label: "fix the bug", reply: "I checked the code and it" },
      { row: 2, offset: 40, label: "second", reply: "" },
    ]);
    expect(decodePiNavPayload("e-pi:nav:v1;nope,label")).toBeNull();
    expect(decodePiNavPayload("other:payload")).toBeNull();
  });
});
