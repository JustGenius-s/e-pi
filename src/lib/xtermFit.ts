import type { FitAddon, ITerminalDimensions } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

interface FitCellDimensions {
  width?: number;
  height?: number;
}

interface FitTerminalCore {
  _renderService?: { dimensions?: { css?: { cell?: FitCellDimensions } } };
}

/**
 * FitAddon measures `getComputedStyle(parent).width`, which in Chromium is the
 * border-box of `.terminal-panel`, then subtracts only `.xterm`'s padding (0)
 * and a 14px scrollbar gutter. The panel's own padding is never removed, so
 * the canvas is wider than `.xterm` / `.xterm-scrollable-element` and the
 * extra columns are clipped by `.terminal-frame { overflow: hidden }`.
 *
 * Measure the laid-out terminal element instead.
 */
export function proposeDimensionsForElement(terminal: Terminal): ITerminalDimensions | undefined {
  const element = terminal.element;
  if (!element) return undefined;

  /* eslint-disable no-underscore-dangle */
  const cell = (terminal as unknown as { _core?: FitTerminalCore })._core?._renderService?.dimensions?.css?.cell;
  /* eslint-enable no-underscore-dangle */
  const cellWidth = cell?.width ?? 0;
  const cellHeight = cell?.height ?? 0;
  if (cellWidth <= 0 || cellHeight <= 0) return undefined;

  const availableWidth = element.clientWidth;
  const availableHeight = element.clientHeight;
  if (availableWidth <= 0 || availableHeight <= 0) return undefined;

  return {
    cols: Math.max(2, Math.floor(availableWidth / cellWidth)),
    rows: Math.max(1, Math.floor(availableHeight / cellHeight)),
  };
}

/** Make `fit.fit()` / `proposeDimensions()` use `.xterm`'s content box. */
export function fitToTerminalElement(fit: FitAddon, terminal: Terminal): void {
  fit.proposeDimensions = () => proposeDimensionsForElement(terminal);
}
