import type { IDisposable, Terminal } from "@xterm/xterm";

export interface TerminalResizeVisualGuard {
  /** Cover the live renderer with its last fully composed frame. */
  begin(onReady?: () => void): void;
  /** Refresh the front buffer from a complete local reflow. */
  track(): void;
  /** Freeze the current front while a hidden authoritative frame parses. */
  hold(): void;
  /** Atomically present a complete frame and keep the guard active. */
  presentAfterRender(onPresented: () => void): void;
  /** Reveal the already-presented live renderer on the next composition frame. */
  release(): void;
  /** Capture one final complete render, then reveal it. */
  endAfterRender(): void;
  /** Immediately reveal the live renderer. */
  end(): void;
  dispose(): void;
}

const SNAPSHOT_CLASS = "xterm-resize-snapshot";
type GuardPhase = "inactive" | "priming" | "tracking" | "holding" | "presenting" | "ending" | "releasing";

interface SnapshotBuffer {
  root: HTMLDivElement;
  canvas: HTMLCanvasElement;
}

/**
 * Visual double buffering for xterm resize.
 *
 * FitAddon replaces renderer canvases synchronously, while a complete redraw
 * lands later. A copied front buffer stays above xterm through the whole
 * resize pipeline. Local previews and authoritative checkpoints render into
 * the hidden live canvas, then swap into the front atomically. Repeated drag
 * checkpoints keep the same two buffers alive; the live renderer is revealed
 * only after the latest acknowledged grid has settled.
 */
export function createTerminalResizeVisualGuard(terminal: Terminal): TerminalResizeVisualGuard {
  let phase: GuardPhase = "inactive";
  let disposed = false;
  let frontBuffer: SnapshotBuffer | undefined;
  let backBuffer: SnapshotBuffer | undefined;
  let bufferScreen: HTMLElement | undefined;
  let renderSubscription: IDisposable | undefined;
  let captureFrame: number | undefined;
  let releaseFrame: number | undefined;
  let releaseGeneration = 0;
  let captureAttempts = 0;
  let readyCallback: (() => void) | undefined;
  let presentedCallback: (() => void) | undefined;

  const getScreen = (): HTMLElement | undefined =>
    terminal.element?.querySelector<HTMLElement>(".xterm-screen") ?? undefined;

  const createBuffer = (): SnapshotBuffer => {
    const root = document.createElement("div");
    root.className = SNAPSHOT_CLASS;
    root.setAttribute("aria-hidden", "true");
    Object.assign(root.style, {
      display: "none",
      inset: "0",
      overflow: "hidden",
      pointerEvents: "none",
      position: "absolute",
      // Renderer canvases live at z-index 0-3. Stay below xterm's IME and
      // app-owned overlays; the enclosing .xterm stacking context prevents
      // this snapshot from covering the composer quick-command row.
      zIndex: "4",
    });
    const canvas = document.createElement("canvas");
    Object.assign(canvas.style, {
      left: "0",
      pointerEvents: "none",
      position: "absolute",
      top: "0",
    });
    root.append(canvas);
    return { root, canvas };
  };

  const releaseBuffers = (): void => {
    frontBuffer?.root.remove();
    backBuffer?.root.remove();
    frontBuffer = undefined;
    backBuffer = undefined;
    bufferScreen = undefined;
  };

  const cancelPendingWork = (): void => {
    releaseGeneration += 1;
    if (captureFrame !== undefined) cancelAnimationFrame(captureFrame);
    if (releaseFrame !== undefined) cancelAnimationFrame(releaseFrame);
    captureFrame = undefined;
    releaseFrame = undefined;
    captureAttempts = 0;
    readyCallback = undefined;
    presentedCallback = undefined;
  };

  const hasWebglSource = (): boolean => {
    const screen = getScreen();
    if (!screen) return false;
    const sources = Array.from(screen.querySelectorAll<HTMLCanvasElement>("canvas"));
    for (const source of sources) {
      if (source === frontBuffer?.canvas || source === backBuffer?.canvas) continue;
      try {
        if (source.getContext?.("webgl2")) return true;
      } catch {
        // A non-WebGL renderer may have already claimed this canvas.
      }
    }
    return false;
  };

  const ensureBuffers = (screen: HTMLElement): [SnapshotBuffer, SnapshotBuffer] => {
    if (frontBuffer && backBuffer && bufferScreen === screen) return [frontBuffer, backBuffer];
    releaseBuffers();
    frontBuffer = createBuffer();
    backBuffer = createBuffer();
    bufferScreen = screen;
    screen.append(frontBuffer.root, backBuffer.root);
    return [frontBuffer, backBuffer];
  };

  const canvasCssDimension = (
    canvas: HTMLCanvasElement,
    dimension: "width" | "height",
    backingPixels: number,
  ): string => {
    const styled = canvas.style[dimension];
    if (styled) return styled;
    const rect = canvas.getBoundingClientRect?.();
    const measured = dimension === "width" ? rect?.width : rect?.height;
    if (measured && measured > 0) return `${measured}px`;
    const dpr = canvas.ownerDocument?.defaultView?.devicePixelRatio ?? window.devicePixelRatio ?? 1;
    return `${backingPixels / Math.max(1, dpr)}px`;
  };

  const capture = (): boolean => {
    const screen = getScreen();
    if (!screen) return false;
    const [front, back] = ensureBuffers(screen);
    const sources = Array.from(screen.querySelectorAll<HTMLCanvasElement>("canvas")).filter(
      (canvas) => canvas !== front.canvas && canvas !== back.canvas && canvas.width > 0 && canvas.height > 0,
    );
    if (sources.length === 0) return false;

    let primary = sources[0];
    let primaryGl: WebGL2RenderingContext | null = null;
    for (const source of sources) {
      try {
        const gl = source.getContext?.("webgl2") as WebGL2RenderingContext | null;
        if (gl) {
          primary = source;
          primaryGl = gl;
          break;
        }
      } catch {
        // A canvas renderer has already claimed a non-WebGL context.
      }
    }

    const width = primary.width;
    const height = primary.height;
    const renderLayers = [
      primary,
      ...sources.filter((canvas) => canvas !== primary && canvas.width === width && canvas.height === height),
    ].sort((left, right) => {
      const leftZ = Number.parseInt(left.style.zIndex || "0", 10);
      const rightZ = Number.parseInt(right.style.zIndex || "0", 10);
      return leftZ - rightZ;
    });
    if (back.canvas.width !== width) back.canvas.width = width;
    if (back.canvas.height !== height) back.canvas.height = height;
    // Keep the copied bitmap at the renderer canvas' native CSS size. The
    // outer root clips/extends it as the host changes, avoiding font scaling.
    back.canvas.style.width = canvasCssDimension(primary, "width", width);
    back.canvas.style.height = canvasCssDimension(primary, "height", height);

    const context = back.canvas.getContext("2d", { alpha: false });
    if (!context) return false;
    const background =
      terminal.options.theme?.background ?? getComputedStyle(terminal.element ?? screen).backgroundColor;
    try {
      back.root.style.backgroundColor = background;
      context.fillStyle = background;
      context.fillRect(0, 0, width, height);
      primaryGl?.finish();
      for (const source of renderLayers) context.drawImage(source, 0, 0);
    } catch {
      return false;
    }

    back.root.style.display = "block";
    front.root.style.display = "none";
    frontBuffer = back;
    backBuffer = front;
    return true;
  };

  const scheduleRelease = (generation: number): void => {
    phase = "releasing";
    releaseFrame = requestAnimationFrame(() => {
      releaseFrame = undefined;
      if (disposed || phase !== "releasing" || generation !== releaseGeneration) return;
      phase = "inactive";
      releaseBuffers();
    });
  };

  const finishPresentationWithoutCapture = (generation: number): void => {
    const callback = presentedCallback;
    presentedCallback = undefined;
    if (phase === "ending") {
      scheduleRelease(generation);
      return;
    }
    phase = "holding";
    callback?.();
  };

  const finishPrimingWithoutCapture = (): void => {
    const callback = readyCallback;
    readyCallback = undefined;
    phase = "inactive";
    releaseBuffers();
    callback?.();
  };

  const captureRenderedFrame = (generation: number): void => {
    if (disposed || generation !== releaseGeneration) return;
    if (phase !== "priming" && phase !== "tracking" && phase !== "presenting" && phase !== "ending") {
      return;
    }
    if (!capture()) {
      if (phase === "tracking") return;
      captureAttempts += 1;
      if (captureAttempts <= 4) {
        try {
          terminal.refresh(0, Math.max(0, terminal.rows - 1));
        } catch {
          if (phase === "priming") finishPrimingWithoutCapture();
          else finishPresentationWithoutCapture(generation);
        }
        return;
      }
      // Never let a lost WebGL context stall either the resize scheduler or
      // the authoritative-frame pipeline.
      if (phase === "priming") finishPrimingWithoutCapture();
      else finishPresentationWithoutCapture(generation);
      return;
    }

    captureAttempts = 0;
    if (phase === "priming") {
      const callback = readyCallback;
      readyCallback = undefined;
      phase = "tracking";
      callback?.();
      return;
    }
    if (phase === "tracking") return;
    if (phase === "ending") {
      scheduleRelease(generation);
      return;
    }
    const callback = presentedCallback;
    presentedCallback = undefined;
    phase = "holding";
    callback?.();
  };

  const queueCapture = (): void => {
    if (captureFrame !== undefined || disposed) return;
    const generation = releaseGeneration;
    captureFrame = requestAnimationFrame(() => {
      captureFrame = undefined;
      captureRenderedFrame(generation);
    });
  };

  const requestPresentation = (onPresented: (() => void) | undefined, shouldRelease: boolean): void => {
    if (disposed) return;
    cancelPendingWork();
    if (!frontBuffer || !backBuffer) {
      phase = "inactive";
      releaseBuffers();
      onPresented?.();
      return;
    }
    presentedCallback = onPresented;
    phase = shouldRelease ? "ending" : "presenting";
    try {
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
    } catch {
      const callback = presentedCallback;
      presentedCallback = undefined;
      phase = "inactive";
      releaseBuffers();
      callback?.();
    }
  };

  renderSubscription = terminal.onRender(({ start, end }) => {
    if (disposed) return;
    if (start !== 0 || end < terminal.rows - 1) return;
    if (phase !== "priming" && phase !== "tracking" && phase !== "presenting" && phase !== "ending") return;
    // A non-preserved WebGL drawing buffer is only guaranteed to be readable
    // in the render task that produced it. Copy there, and only while a resize
    // transaction is active. Canvas fallback buffers remain readable later.
    if (hasWebglSource()) captureRenderedFrame(releaseGeneration);
    else queueCapture();
  });

  return {
    begin(onReady) {
      if (disposed) {
        onReady?.();
        return;
      }
      if (phase === "priming") {
        const previous = readyCallback;
        readyCallback = () => {
          previous?.();
          onReady?.();
        };
        return;
      }
      if (phase === "tracking") {
        onReady?.();
        return;
      }
      cancelPendingWork();
      if (phase === "inactive") {
        // Canvas renderers retain their bitmap and can be copied immediately.
        // WebGL uses the default non-preserved buffer for smooth streaming, so
        // prime a fresh full render and capture it synchronously from onRender.
        if (!hasWebglSource()) {
          phase = "tracking";
          if (capture()) {
            onReady?.();
            return;
          }
        }
        phase = "priming";
        readyCallback = onReady;
        try {
          terminal.refresh(0, Math.max(0, terminal.rows - 1));
        } catch {
          finishPrimingWithoutCapture();
        }
      } else {
        phase = "holding";
        onReady?.();
      }
    },

    track() {
      if (disposed || phase === "inactive") return;
      cancelPendingWork();
      phase = "tracking";
      try {
        terminal.refresh(0, Math.max(0, terminal.rows - 1));
      } catch {
        phase = "inactive";
        releaseBuffers();
      }
    },

    hold() {
      if (disposed || phase === "inactive") return;
      cancelPendingWork();
      phase = "holding";
    },

    presentAfterRender(onPresented) {
      requestPresentation(onPresented, false);
    },

    release() {
      if (disposed || phase === "inactive") return;
      cancelPendingWork();
      if (!frontBuffer || !backBuffer) {
        phase = "inactive";
        releaseBuffers();
        return;
      }
      scheduleRelease(releaseGeneration);
    },

    endAfterRender() {
      requestPresentation(undefined, true);
    },

    end() {
      if (disposed) return;
      cancelPendingWork();
      phase = "inactive";
      releaseBuffers();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      cancelPendingWork();
      phase = "inactive";
      renderSubscription?.dispose();
      renderSubscription = undefined;
      releaseBuffers();
    },
  };
}
