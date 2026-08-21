/** Compact token label: 256000 → "256k", 1000000 → "1M". */
export function compactTokenLabel(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}k`;
  if (tokens >= 1_000_000) return `${Math.round((tokens / 1_000_000) * 10) / 10}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/** Preset menu label: "1M - 1000000". */
export function tokenPresetLabel(tokens: number): string {
  return `${compactTokenLabel(tokens)} - ${tokens}`;
}

export const CONTEXT_WINDOW_PRESETS = [8192, 16384, 32768, 64000, 128000, 200000, 256000, 1_000_000, 2_000_000];
export const MAX_OUTPUT_PRESETS = [2048, 4096, 8192, 16384, 32768, 64000, 128000];

const MAX_TOKENS = 1_000_000_000;

/**
 * Parse a token count typed into the model settings field.
 * Accepts integers, grouped digits (128,000 / 128_000), and k/M suffixes (128k, 1.5M).
 */
export function parseTokenInput(raw: string): number | undefined {
  const trimmed = raw.trim().replace(/[,\s_]/g, "");
  if (!trimmed) return undefined;
  const match = /^(\d+(?:\.\d+)?)([kKmM])?$/.exec(trimmed);
  if (!match) return undefined;
  const magnitude = Number(match[1]);
  if (!Number.isFinite(magnitude) || magnitude <= 0) return undefined;
  const suffix = match[2]?.toLowerCase();
  const tokens = suffix === "m" ? magnitude * 1_000_000 : suffix === "k" ? magnitude * 1_000 : magnitude;
  const rounded = Math.round(tokens);
  if (!Number.isFinite(rounded) || rounded < 1 || rounded > MAX_TOKENS) return undefined;
  return rounded;
}
