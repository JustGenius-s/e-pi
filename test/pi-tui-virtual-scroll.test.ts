import { Container, ScrollView, stripTerminalSequences } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { afterEach, describe, expect, it, vi } from "vitest";

class CountingBlock {
  readonly calls = new Map<number, number>();

  constructor(
    readonly id: number,
    private readonly lineCount: (width: number, id: number) => number,
  ) {}

  expected(width: number): string[] {
    return Array.from({ length: this.lineCount(width, this.id) }, (_, line) => {
      return `block-${this.id}@${width}:${line}`;
    });
  }

  render(width: number): string[] {
    this.calls.set(width, (this.calls.get(width) ?? 0) + 1);
    return this.expected(width);
  }

  invalidate(): void {}
}

function makeTranscript(
  count: number,
  lineCount: (width: number, id: number) => number,
): { blocks: CountingBlock[]; scrollView: ScrollView } {
  const document = new Container();
  const chat = new Container();
  const blocks = Array.from({ length: count }, (_, id) => new CountingBlock(id, lineCount));
  for (const block of blocks) chat.addChild(block);
  document.addChild(chat);
  return {
    blocks,
    scrollView: new ScrollView(document, { follow: "end", primary: true }),
  };
}

function visibleText(lines: readonly string[]): string[] {
  return lines.map((line) => stripTerminalSequences(line).trimEnd());
}

function expectedTail(blocks: CountingBlock[], width: number, height: number): string[] {
  return blocks.flatMap((block) => block.expected(width)).slice(-height);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("patched pi-tui virtual transcript layout", () => {
  it("renders the authoritative tail at a new width without laying out the full history", () => {
    const { blocks, scrollView } = makeTranscript(120, (width, id) => {
      return width < 60 ? (id % 3) + 1 : (id % 2) + 1;
    });

    const narrow = renderLayoutFrame(scrollView, 48, 12, () => undefined);
    expect(visibleText(narrow.lines)).toEqual(expectedTail(blocks, 48, 12));
    expect(blocks.filter((block) => (block.calls.get(48) ?? 0) > 0).length).toBeLessThan(20);
    expect(blocks[0].calls.get(48)).toBeUndefined();

    const wide = renderLayoutFrame(scrollView, 96, 12, () => undefined);
    expect(visibleText(wide.lines)).toEqual(expectedTail(blocks, 96, 12));
    expect(blocks.filter((block) => (block.calls.get(96) ?? 0) > 0).length).toBeLessThan(20);
    expect(blocks[0].calls.get(96)).toBeUndefined();

    scrollView.invalidate();
  });

  it("keeps the same transcript block anchored while a scrolled viewport reflows", () => {
    const { blocks, scrollView } = makeTranscript(80, (width) => (width < 40 ? 2 : 1));

    renderLayoutFrame(scrollView, 80, 8, () => undefined);
    scrollView.scrollBy(-4);
    const beforeResize = renderLayoutFrame(scrollView, 80, 8, () => undefined);
    expect(visibleText(beforeResize.lines)[0]).toBe("block-68@80:0");

    const afterResize = renderLayoutFrame(scrollView, 32, 8, () => undefined);
    expect(visibleText(afterResize.lines)[0]).toBe("block-68@32:0");
    expect(blocks[0].calls.get(32)).toBeUndefined();

    scrollView.scrollToStart();
    const atStart = renderLayoutFrame(scrollView, 32, 8, () => undefined);
    expect(visibleText(atStart.lines)[0]).toBe("block-0@32:0");

    scrollView.scrollToEnd();
    const atEnd = renderLayoutFrame(scrollView, 32, 8, () => undefined);
    expect(visibleText(atEnd.lines)).toEqual(expectedTail(blocks, 32, 8));

    scrollView.invalidate();
  });

  it("cancels stale-width hydration and only fills history for the latest width", async () => {
    vi.useFakeTimers();
    const { blocks, scrollView } = makeTranscript(80, () => 1);

    renderLayoutFrame(scrollView, 48, 8, () => undefined);
    expect(blocks[0].calls.get(48)).toBeUndefined();

    renderLayoutFrame(scrollView, 96, 8, () => undefined);
    await vi.runAllTimersAsync();

    expect(blocks[0].calls.get(48)).toBeUndefined();
    expect(blocks[0].calls.get(96)).toBe(1);
    expect(blocks.every((block) => block.calls.get(96) === 1)).toBe(true);

    scrollView.invalidate();
  });

  it("keeps every intermediate drag width on the latest authoritative tail", () => {
    const { blocks, scrollView } = makeTranscript(100, (width, id) => {
      return width < 64 ? (id % 2) + 1 : (id % 3) + 1;
    });
    const widths = [48, 56, 64, 72, 80, 88];

    for (const width of widths) {
      const frame = renderLayoutFrame(scrollView, width, 10, () => undefined);
      expect(visibleText(frame.lines)).toEqual(expectedTail(blocks, width, 10));
    }

    expect(blocks[0].calls.size).toBeLessThan(widths.length);
    expect(blocks[0].calls.get(88)).toBeUndefined();
    scrollView.invalidate();
  });

  it("keeps rapid width reversals latest-wins and cancels abandoned hydration", async () => {
    vi.useFakeTimers();
    const { blocks, scrollView } = makeTranscript(100, (width, id) => {
      return width < 64 ? (id % 3) + 1 : (id % 2) + 1;
    });
    const widths = [48, 96, 52, 92, 56, 88];

    for (const width of widths) {
      const frame = renderLayoutFrame(scrollView, width, 10, () => undefined);
      expect(visibleText(frame.lines)).toEqual(expectedTail(blocks, width, 10));
    }

    await vi.runAllTimersAsync();
    const finalWidth = widths.at(-1)!;
    const settled = renderLayoutFrame(scrollView, finalWidth, 10, () => undefined);
    expect(visibleText(settled.lines)).toEqual(expectedTail(blocks, finalWidth, 10));
    for (const abandonedWidth of widths.slice(0, -1)) {
      expect(blocks[0].calls.get(abandonedWidth)).toBeUndefined();
    }
    expect(blocks[0].calls.get(finalWidth)).toBe(1);

    scrollView.invalidate();
  });

  it("does not change the visible tail when idle hydration fills historical heights", async () => {
    vi.useFakeTimers();
    const { blocks, scrollView } = makeTranscript(100, (width, id) => (id % 4) + (width < 60 ? 1 : 2));

    const first = renderLayoutFrame(scrollView, 48, 10, () => undefined);
    const beforeHydration = visibleText(first.lines);
    await vi.runAllTimersAsync();
    const afterHydration = renderLayoutFrame(scrollView, 48, 10, () => undefined);

    expect(visibleText(afterHydration.lines)).toEqual(beforeHydration);
    expect(visibleText(afterHydration.lines)).toEqual(expectedTail(blocks, 48, 10));
    expect(blocks[0].calls.get(48)).toBe(1);
    scrollView.invalidate();
  });
});
