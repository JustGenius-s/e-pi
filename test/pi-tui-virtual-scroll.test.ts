import { Container, ScrollView, Spacer, stripTerminalSequences, Text, VStack } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

class VolatileBlock {
  readonly ePiVirtualRenderVolatile = true;
  calls = 0;
  text = "before";

  render(): string[] {
    this.calls += 1;
    return [this.text];
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

beforeEach(() => {
  process.env.E_PI_TUI_OPTIMIZATIONS = "true";
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.E_PI_TUI_OPTIMIZATIONS;
});

describe("patched pi-tui virtual transcript layout", () => {
  it("uses Pi's stock full transcript layout while the patch is disabled", () => {
    process.env.E_PI_TUI_OPTIMIZATIONS = "false";
    const { blocks, scrollView } = makeTranscript(40, () => 1);

    const frame = renderLayoutFrame(scrollView, 80, 8, () => undefined);

    expect(visibleText(frame.lines)).toEqual(expectedTail(blocks, 80, 8));
    expect(blocks.every((block) => block.calls.get(80) === 1)).toBe(true);
  });

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

  it("defers offscreen hydration while foreground frames keep arriving", () => {
    vi.useFakeTimers();
    const { blocks, scrollView } = makeTranscript(100, () => 1);
    const requestRender = vi.fn();
    const render = () => renderLayoutFrame(scrollView, 80, 12, requestRender);
    const renderedBlockCalls = () => blocks.reduce((total, block) => total + (block.calls.get(80) ?? 0), 0);

    render();
    const initialCalls = renderedBlockCalls();
    for (let frame = 0; frame < 8; frame += 1) {
      vi.advanceTimersByTime(499);
      render();
    }

    expect(renderedBlockCalls()).toBe(initialCalls);
    expect(requestRender).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(renderedBlockCalls()).toBe(initialCalls + 1);
    expect(requestRender).toHaveBeenCalledOnce();

    render();
    vi.advanceTimersByTime(499);
    expect(renderedBlockCalls()).toBe(initialCalls + 1);
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

  it("reuses same-width block renders while the viewport scrolls", () => {
    const { blocks, scrollView } = makeTranscript(120, () => 1);

    renderLayoutFrame(scrollView, 80, 12, () => undefined);
    for (let step = 0; step < 20; step += 1) {
      scrollView.scrollBy(-1);
      renderLayoutFrame(scrollView, 80, 12, () => undefined);
    }

    expect(Math.max(...blocks.map((block) => block.calls.get(80) ?? 0))).toBe(1);
    scrollView.invalidate();
  });

  it("invalidates cached mutable leaf and nested container content", () => {
    const document = new Container();
    for (let index = 0; index < 38; index += 1) document.addChild(new CountingBlock(index, () => 1));
    const nested = new Container();
    const mutable = new Text("before", 0, 0);
    nested.addChild(mutable);
    document.addChild(nested);
    const scrollView = new ScrollView(document, { follow: "end", primary: true });

    expect(visibleText(renderLayoutFrame(scrollView, 80, 6, () => undefined).lines)).toContain("before");
    mutable.setText("after-text-update");
    expect(visibleText(renderLayoutFrame(scrollView, 80, 6, () => undefined).lines)).toContain("after-text-update");

    nested.clear();
    nested.addChild(new Text("after-tree-update", 0, 0));
    expect(visibleText(renderLayoutFrame(scrollView, 80, 6, () => undefined).lines)).toContain("after-tree-update");
    scrollView.invalidate();
  });

  it("re-renders volatile E-Pi widgets without invalidating cached transcript blocks", () => {
    const document = new Container();
    for (let index = 0; index < 38; index += 1) document.addChild(new CountingBlock(index, () => 1));
    const widget = new VolatileBlock();
    document.addChild(widget);
    const scrollView = new ScrollView(document, { follow: "end", primary: true });

    expect(visibleText(renderLayoutFrame(scrollView, 80, 6, () => undefined).lines)).toContain("before");
    widget.text = "after";
    expect(visibleText(renderLayoutFrame(scrollView, 80, 6, () => undefined).lines)).toContain("after");
    expect(widget.calls).toBe(2);
    scrollView.invalidate();
  });

  it("keeps the fullscreen dock fixed while the working status scrolls with the transcript", () => {
    const document = new Container();
    for (let index = 0; index < 40; index += 1) document.addChild(new CountingBlock(index, () => 1));
    const status = new Container();
    status.addChild(new Text("Working... 0:42", 0, 0));
    const fullscreenTranscript = new Container();
    fullscreenTranscript.addChild(document);
    fullscreenTranscript.addChild(status);
    const scrollView = new ScrollView(fullscreenTranscript, { follow: "end", primary: true });
    const dock = new Text("EDITOR", 0, 0);
    const root = new VStack([
      { component: scrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: dock, basis: 1, grow: 0, shrink: 0, minSize: 1 },
    ]);

    const atBottom = visibleText(renderLayoutFrame(root, 80, 8, () => undefined).lines);
    expect(atBottom).toContain("Working... 0:42");
    expect(atBottom.at(-1)).toBe("EDITOR");

    scrollView.scrollBy(-10);
    const scrolled = visibleText(renderLayoutFrame(root, 80, 8, () => undefined).lines);
    expect(scrolled).not.toContain("Working... 0:42");
    expect(scrolled.at(-1)).toBe("EDITOR");
    scrollView.invalidate();
  });

  it("scrolls E-Pi information widgets with the transcript while keeping interactive UI docked", () => {
    const document = new Container();
    const blocks = Array.from({ length: 20 }, (_, id) => new CountingBlock(id, () => 1));
    for (const block of blocks) document.addChild(block);
    const pending = new Container();
    const status = new Container();
    const widgetAbove = new Container();
    const widgetBelow = new Container();
    const fullscreenTranscript = new Container();
    fullscreenTranscript.addChild(document);
    fullscreenTranscript.addChild(status);
    fullscreenTranscript.addChild(pending);
    fullscreenTranscript.addChild(widgetAbove);
    fullscreenTranscript.addChild(widgetBelow);
    fullscreenTranscript.addChild(new Spacer(4));
    const scrollView = new ScrollView(fullscreenTranscript, { follow: "end", primary: true });
    const editor = new Container();
    const footer = new Container();
    const dock = new VStack([
      { component: editor, shrink: 1, minSize: 0 },
      { component: footer, shrink: 1, minSize: 0 },
    ]);
    const root = new VStack([
      { component: scrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 0 },
    ]);

    expect(visibleText(renderLayoutFrame(root, 80, 8, () => undefined).lines)).toEqual([
      ...expectedTail(blocks, 80, 4),
      "",
      "",
      "",
      "",
    ]);

    widgetAbove.addChild(new Text("TODOS", 0, 0));
    const atBottom = visibleText(renderLayoutFrame(root, 80, 8, () => undefined).lines);
    expect(atBottom.at(-5)).toBe("TODOS");
    expect(atBottom.slice(-4)).toEqual(["", "", "", ""]);

    scrollView.scrollBy(-8);
    const scrolled = visibleText(renderLayoutFrame(root, 80, 8, () => undefined).lines);
    expect(scrolled).not.toContain("TODOS");

    editor.addChild(new Text("PERMISSION", 0, 0));
    scrollView.scrollToEnd();
    const withInteractiveUi = visibleText(renderLayoutFrame(root, 80, 8, () => undefined).lines);
    expect(withInteractiveUi.at(-1)).toBe("PERMISSION");
    expect(withInteractiveUi.at(-6)).toBe("TODOS");
    expect(withInteractiveUi.slice(-5, -1)).toEqual(["", "", "", ""]);
    scrollView.invalidate();
  });
});
