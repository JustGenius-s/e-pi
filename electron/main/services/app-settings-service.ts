import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { app } from "electron";

/** E-Pi-level settings, stored separately from the pi agent config. */
export interface AppSettings {
  defaultCwd?: string;
  /** .app bundle path used by the file tree's "open with" (undefined = system default). */
  openWithApp?: string;
  /** Inject E-Pi's optional performance layer into Pi's TUI. Defaults on. */
  tuiOptimizationsEnabled: boolean;
}

function settingsPath(): string {
  return join(app.getPath("userData"), "app-settings.json");
}

let cached: AppSettings | undefined;

function sanitizeSettings(input: unknown): AppSettings {
  const parsed = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  return {
    defaultCwd: typeof parsed.defaultCwd === "string" ? parsed.defaultCwd : undefined,
    openWithApp: typeof parsed.openWithApp === "string" ? parsed.openWithApp : undefined,
    tuiOptimizationsEnabled: parsed.tuiOptimizationsEnabled !== false,
  };
}

export async function getAppSettings(): Promise<AppSettings> {
  if (cached) return { ...cached };
  try {
    const raw = await readFile(settingsPath(), "utf8");
    cached = sanitizeSettings(JSON.parse(raw) as unknown);
  } catch {
    // Missing or malformed file — fall back to defaults.
    cached = sanitizeSettings(undefined);
  }
  return { ...cached };
}

/** Synchronous read used by package resolution and PTY launch paths. */
export function isTuiOptimizationsEnabled(): boolean {
  if (cached) return cached.tuiOptimizationsEnabled;
  try {
    cached = sanitizeSettings(JSON.parse(readFileSync(settingsPath(), "utf8")) as unknown);
  } catch {
    cached = sanitizeSettings(undefined);
  }
  return cached.tuiOptimizationsEnabled;
}

async function writeSettings(next: AppSettings): Promise<void> {
  const path = settingsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2), "utf8");
  cached = next;
}

export async function setDefaultCwd(cwd: string): Promise<void> {
  const current = await getAppSettings();
  const next = { ...current, defaultCwd: cwd };
  await writeSettings(next);
}

export async function setOpenWithApp(appPath: string | undefined): Promise<void> {
  const current = await getAppSettings();
  const next = { ...current, openWithApp: appPath };
  await writeSettings(next);
}

export async function setTuiOptimizationsEnabled(enabled: boolean): Promise<void> {
  const current = await getAppSettings();
  await writeSettings({ ...current, tuiOptimizationsEnabled: enabled });
}

export async function resolveDefaultCwd(): Promise<string> {
  const settings = await getAppSettings();
  return settings.defaultCwd?.trim() || app.getPath("home");
}
