import type { ITheme } from "@xterm/xterm";

/** ANSI palette (dark): the slate pastel palette the app has always used. */
const DARK_PALETTE: Omit<ITheme, "background"> = {
  foreground: "#d7e0e9",
  cursor: "#74d6a5",
  selectionBackground: "#314b58",
  black: "#18212a",
  red: "#ed8b92",
  green: "#74d6a5",
  yellow: "#e3c47a",
  blue: "#8db9e8",
  magenta: "#c6a1df",
  cyan: "#72c6c7",
  white: "#d7e0e9",
  brightBlack: "#526171",
  brightRed: "#ff9b9f",
  brightGreen: "#8be6b4",
  brightYellow: "#f3d994",
  brightBlue: "#a9cdf5",
  brightMagenta: "#dbb8f1",
  brightCyan: "#91e2e0",
  brightWhite: "#f0f4f7",
};

/**
 * ANSI palette (light): GitHub's light terminal palette — the same color
 * family the app already renders diffs with (shiki github-light).
 */
const LIGHT_PALETTE: Omit<ITheme, "background"> = {
  foreground: "#24292f",
  cursor: "#0969da",
  selectionBackground: "#c8e1ff",
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#9a6700",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#57606a",
  brightBlack: "#6e7781",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#218bff",
  brightMagenta: "#6639ba",
  brightCyan: "#3192aa",
  brightWhite: "#57606a",
};

/**
 * Full xterm theme; background follows the rendered surface so the terminal
 * blends with its panel instead of painting a separate frame.
 */
export function terminalTheme(isDark: boolean, background: string): ITheme {
  return { background, ...(isDark ? DARK_PALETTE : LIGHT_PALETTE) };
}
