import type { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTerminalResizeVisualGuard } from "../src/lib/terminalResizeVisualGuard";

interface FakeContext {
  fillStyle: string;
  fillRect: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
}

interface CanvasRecord {
  root: HTMLDivElement;
  canvas: HTMLCanvasElement;
  context: FakeContext;
}

function createHarness(options: { webgl?: boolean } = {}) {
  const webglFinish = vi.fn();
  const webglContext = { finish: webglFinish };
  const createSource = (width: number, height: number) =>
    ({
      width,
      height,
      style: {
        width: `${width / 2}px`,
        height: `${height / 2}px`,
      },
      getContext: options.webgl
        ? vi.fn((contextId: string) => (contextId === "webgl2" ? webglContext : null))
        : undefined,
    }) as unknown as HTMLCanvasElement;
  const source = createSource(320, 180);
  const children: HTMLElement[] = [source];
  const canvases: HTMLCanvasElement[] = [source];
  const overlays: CanvasRecord[] = [];
  const contexts = new Map<HTMLCanvasElement, FakeContext>();
  let renderListener: ((event: { start: number; end: number }) => void) | undefined;
  const renderDispose = vi.fn();
  let animationFrames = new Map<number, () => void>();
  let nextAnimationFrame = 1;

  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: () => void) => {
      const id = nextAnimationFrame;
      nextAnimationFrame += 1;
      animationFrames.set(id, callback);
      return id;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => animationFrames.delete(id)),
  );

  vi.stubGlobal("document", {
    createElement: vi.fn((tagName: string) => {
      if (tagName === "div") {
        let child: HTMLCanvasElement | undefined;
        const root = {
          className: "",
          style: { display: "" },
          setAttribute: vi.fn(),
          append: vi.fn((node: HTMLCanvasElement) => {
            child = node;
            canvases.push(node);
            overlays.push({ root: root as unknown as HTMLDivElement, canvas: node, context: contexts.get(node)! });
          }),
          remove: vi.fn(() => {
            const index = children.indexOf(root as unknown as HTMLElement);
            if (index >= 0) children.splice(index, 1);
            if (child) {
              const canvasIndex = canvases.indexOf(child);
              if (canvasIndex >= 0) canvases.splice(canvasIndex, 1);
            }
          }),
        };
        return root;
      }
      const context: FakeContext = {
        fillStyle: "",
        fillRect: vi.fn(),
        drawImage: vi.fn(),
      };
      const canvas = {
        width: 0,
        height: 0,
        className: "",
        style: { display: "" },
        setAttribute: vi.fn(),
        getContext: vi.fn(() => context),
      } as unknown as HTMLCanvasElement;
      contexts.set(canvas, context);
      return canvas;
    }),
  });

  const screen = {
    append: vi.fn((...nodes: HTMLElement[]) => children.push(...nodes)),
    querySelectorAll: vi.fn(() => canvases),
  } as unknown as HTMLElement;
  const terminal = {
    element: {
      querySelector: vi.fn(() => screen),
    },
    options: {
      theme: { background: "#101010" },
    },
    rows: 24,
    onRender: vi.fn((listener: (event: { start: number; end: number }) => void) => {
      renderListener = listener;
      return { dispose: renderDispose };
    }),
    refresh: vi.fn(),
  } as unknown as Terminal;

  return {
    children,
    overlays,
    renderDispose,
    terminal,
    webglFinish,
    addSource(width: number, height: number) {
      const extraSource = createSource(width, height);
      children.push(extraSource);
      canvases.push(extraSource);
      return extraSource;
    },
    render(start = 0, end = 23) {
      renderListener?.({ start, end });
    },
    runAnimationFrames() {
      const pending = animationFrames;
      animationFrames = new Map();
      for (const callback of pending.values()) callback();
    },
    visibleOverlay() {
      return overlays.find(({ root }) => root.style.display === "block");
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createTerminalResizeVisualGuard", () => {
  it("primes a non-preserved WebGL snapshot inside the render task", () => {
    const harness = createHarness({ webgl: true });
    const guard = createTerminalResizeVisualGuard(harness.terminal);
    const ready = vi.fn();

    guard.begin(ready);

    expect(harness.terminal.refresh).toHaveBeenCalledWith(0, 23);
    expect(harness.visibleOverlay()).toBeUndefined();
    expect(ready).not.toHaveBeenCalled();

    harness.render();

    expect(harness.visibleOverlay()).toBeDefined();
    expect(harness.webglFinish).toHaveBeenCalledOnce();
    expect(ready).toHaveBeenCalledOnce();
  });

  it("shows a complete front buffer when a resize begins", () => {
    const harness = createHarness();
    const guard = createTerminalResizeVisualGuard(harness.terminal);

    guard.begin();

    expect(harness.overlays).toHaveLength(2);
    expect(harness.visibleOverlay()).toBeDefined();
    expect(harness.visibleOverlay()?.context.drawImage).toHaveBeenCalledOnce();
    expect(harness.visibleOverlay()?.root.style.zIndex).toBe("4");
    expect(harness.visibleOverlay()?.canvas.style.width).toBe("160px");
    expect(harness.visibleOverlay()?.canvas.style.height).toBe("90px");
    expect(harness.visibleOverlay()?.canvas.style.width).not.toBe("100%");
  });

  it("captures into the hidden buffer before swapping it to the front", () => {
    const harness = createHarness();
    const guard = createTerminalResizeVisualGuard(harness.terminal);
    guard.begin();
    const firstFront = harness.visibleOverlay();

    harness.render();
    expect(harness.visibleOverlay()).toBe(firstFront);
    harness.runAnimationFrames();

    const secondFront = harness.visibleOverlay();
    expect(secondFront).toBeDefined();
    expect(secondFront).not.toBe(firstFront);
    expect(firstFront?.root.style.display).toBe("none");
    expect(secondFront?.context.drawImage).toHaveBeenCalledOnce();
  });

  it("keeps the previous front visible when the back-buffer copy fails", () => {
    const harness = createHarness();
    const guard = createTerminalResizeVisualGuard(harness.terminal);
    guard.begin();
    const firstFront = harness.visibleOverlay();
    const hiddenBack = harness.overlays.find((overlay) => overlay !== firstFront);
    hiddenBack?.context.drawImage.mockImplementationOnce(() => {
      throw new Error("lost WebGL context");
    });

    harness.render();
    harness.runAnimationFrames();

    expect(harness.visibleOverlay()).toBe(firstFront);
    expect(firstFront?.root.style.display).toBe("block");
  });

  it("ignores auxiliary renderer layers with mismatched backing sizes", () => {
    const harness = createHarness();
    const guard = createTerminalResizeVisualGuard(harness.terminal);
    guard.begin();
    const firstFront = harness.visibleOverlay();
    harness.addSource(640, 180);

    harness.render();
    harness.runAnimationFrames();

    expect(harness.visibleOverlay()).not.toBe(firstFront);
  });

  it("does not freeze a partial-row render", () => {
    const harness = createHarness();
    const guard = createTerminalResizeVisualGuard(harness.terminal);
    guard.begin();
    const firstFront = harness.visibleOverlay();

    harness.render(5, 10);
    harness.runAnimationFrames();

    expect(harness.visibleOverlay()).toBe(firstFront);
  });

  it("freezes the front buffer while an authoritative frame parses", () => {
    const harness = createHarness();
    const guard = createTerminalResizeVisualGuard(harness.terminal);
    guard.begin();
    const heldFront = harness.visibleOverlay();

    guard.hold();
    harness.render();

    expect(harness.visibleOverlay()).toBe(heldFront);
    const hiddenBack = harness.overlays.find((overlay) => overlay !== heldFront);
    expect(hiddenBack?.context.drawImage).not.toHaveBeenCalled();
  });

  it("reveals only after a full refresh is captured and composited", () => {
    const harness = createHarness();
    const guard = createTerminalResizeVisualGuard(harness.terminal);
    guard.begin();
    const heldFront = harness.visibleOverlay();
    guard.hold();

    guard.endAfterRender();
    expect(harness.terminal.refresh).toHaveBeenCalledWith(0, 23);
    expect(harness.children).toHaveLength(3);

    harness.render();
    expect(harness.visibleOverlay()).toBe(heldFront);
    harness.runAnimationFrames();
    expect(harness.visibleOverlay()).not.toBe(heldFront);
    expect(harness.children).toHaveLength(3);

    harness.runAnimationFrames();
    expect(harness.children).toHaveLength(1);
  });

  it("presents repeated authoritative frames without releasing the guard", () => {
    const harness = createHarness();
    const guard = createTerminalResizeVisualGuard(harness.terminal);
    const presented = vi.fn();
    guard.begin();
    const oldFront = harness.visibleOverlay();
    guard.hold();

    guard.presentAfterRender(presented);
    harness.render();
    harness.runAnimationFrames();

    expect(presented).toHaveBeenCalledOnce();
    expect(harness.visibleOverlay()).not.toBe(oldFront);
    expect(harness.children).toHaveLength(3);

    guard.release();
    expect(harness.children).toHaveLength(3);
    harness.runAnimationFrames();
    expect(harness.children).toHaveLength(1);
  });

  it("resumes local preview tracking after an interrupted reveal reaches a parser boundary", () => {
    const harness = createHarness();
    const guard = createTerminalResizeVisualGuard(harness.terminal);
    guard.begin();
    guard.hold();
    guard.endAfterRender();
    harness.render();
    harness.runAnimationFrames();
    const completedFront = harness.visibleOverlay();

    guard.begin();
    harness.runAnimationFrames();

    expect(harness.children).toHaveLength(3);
    expect(harness.visibleOverlay()).toBe(completedFront);
    harness.render();
    expect(harness.visibleOverlay()).toBe(completedFront);

    guard.track();
    harness.render();
    expect(harness.visibleOverlay()).toBe(completedFront);
    harness.runAnimationFrames();
    expect(harness.visibleOverlay()).not.toBe(completedFront);
  });

  it("releases both buffers on end and unsubscribes on dispose", () => {
    const harness = createHarness();
    const guard = createTerminalResizeVisualGuard(harness.terminal);
    guard.begin();
    const firstBuffers = [...harness.overlays];

    guard.end();

    expect(harness.children).toHaveLength(1);
    for (const { root } of firstBuffers) expect(root.remove).toHaveBeenCalledOnce();

    guard.begin();
    const secondBuffers = harness.overlays.slice(firstBuffers.length);
    expect(harness.children).toHaveLength(3);
    guard.dispose();

    expect(harness.children).toHaveLength(1);
    for (const { root } of secondBuffers) expect(root.remove).toHaveBeenCalledOnce();
    expect(harness.renderDispose).toHaveBeenCalledOnce();
    const overlayCount = harness.overlays.length;
    guard.begin();
    harness.render();
    expect(harness.overlays).toHaveLength(overlayCount);
  });
});
