import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { app } from "electron";

/** E-Pi-level settings, stored separately from the pi agent config. */
interface AppSettings {
  defaultCwd?: string;
}

function settingsPath(): string {
  return join(app.getPath("userData"), "app-settings.json");
}

let cached: AppSettings | undefined;

export async function getAppSettings(): Promise<AppSettings> {
  if (cached) return { ...cached };
  try {
    const raw = await readFile(settingsPath(), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    cached = { defaultCwd: typeof parsed.defaultCwd === "string" ? parsed.defaultCwd : undefined };
  } catch {
    // Missing or malformed file — fall back to defaults.
    cached = {};
  }
  return { ...cached };
}

export async function setDefaultCwd(cwd: string): Promise<void> {
  const current = await getAppSettings();
  const next = { ...current, defaultCwd: cwd };
  const path = settingsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2), "utf8");
  cached = next;
}

export async function resolveDefaultCwd(): Promise<string> {
  const settings = await getAppSettings();
  return settings.defaultCwd?.trim() || app.getPath("home");
}
