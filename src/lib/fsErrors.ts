import type { FsErrorCode } from "../types/contracts";

/**
 * The main process embeds the machine-readable code in Error.message as
 * `[E-PI-FS:CODE] ` because Electron's ipc invoke serialization only
 * preserves `message` across the bridge. This parses it back.
 */
const FS_ERROR_PREFIX = /^\[E-PI-FS:([A-Z_]+)\]\s*/;

export interface ParsedFsError {
  code: FsErrorCode | null;
  message: string;
}

export function parseFsError(error: unknown): ParsedFsError {
  const message = error instanceof Error ? error.message : String(error ?? "").trim();
  const match = FS_ERROR_PREFIX.exec(message);
  if (match) {
    const code = match[1] as FsErrorCode;
    return { code, message: message.slice(match[0].length) };
  }
  return { code: null, message };
}

export function isFsError(error: unknown, code: FsErrorCode): boolean {
  return parseFsError(error).code === code;
}

/** Human message for display; falls back when the error carries no text. */
export function toFsErrorMessage(error: unknown, fallback: string): string {
  const { message } = parseFsError(error);
  return message.trim() || fallback;
}
