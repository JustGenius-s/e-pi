import { app } from "electron";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let logPath: string | undefined;

const enabled = () => process.env.E_PI_DEBUG === "1";

export function debugLogPath(): string {
  if (!logPath) logPath = join(app.getPath("home"), ".e-pi-debug.log");
  return logPath;
}

/** Truncate the log file (called once at app startup when debug mode is on). */
export function resetDebugLog(): void {
  if (!enabled()) return;
  try {
    writeFileSync(debugLogPath(), "");
  } catch {
    // Logging must never break the app.
  }
}

export function debugLog(...parts: unknown[]): void {
  if (!enabled()) return;
  try {
    const line = parts.map((part) => (typeof part === "string" ? part : safeJson(part))).join(" ");
    appendFileSync(debugLogPath(), `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // Logging must never break the app.
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
