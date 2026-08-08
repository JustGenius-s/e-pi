import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { app } from "electron";

import type { PiTuiSettings } from "../../../src/types/contracts";

/**
 * Read/write access to pi's own `settings.json` (the file pi's interactive
 * TUI consumes). E-Pi launches pi in a pty, so these settings fully apply to
 * E-Pi sessions — unlike `agent-config.json`, which maps to CLI args.
 *
 * Saves merge into the existing file instead of replacing it, so keys managed
 * elsewhere (theme, model defaults, packages, …) survive untouched.
 */

function agentDir(): string {
  // Mirrors pi's own resolution: PI_CODING_AGENT_DIR, then ~/.pi/agent.
  const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
  return envDir || join(homedir(), ".pi", "agent");
}

function settingsPath(): string {
  return join(agentDir(), "settings.json");
}

function readSettingsFile(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath(), "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or malformed file — treat as empty; a save recreates it.
  }
  return {};
}

function writeSettingsFile(next: Record<string, unknown>): void {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2), "utf8");
}

export function getPiTuiSettings(): PiTuiSettings {
  const raw = readSettingsFile();
  return {
    quietStartup: raw.quietStartup === true,
    hideThinkingBlock: raw.hideThinkingBlock === true,
  };
}

export function savePiTuiSettings(settings: PiTuiSettings): PiTuiSettings {
  const next: PiTuiSettings = {
    quietStartup: settings.quietStartup === true,
    hideThinkingBlock: settings.hideThinkingBlock === true,
  };
  writeSettingsFile({ ...readSettingsFile(), ...next });
  return next;
}

/**
 * Auto theme setting: pi's `"<light>/<dark>"` format (light variant first)
 * picks the theme variant from the terminal background at launch. E-Pi
 * injects `COLORFGBG` into the pi process (following the app theme), so
 * sessions start with the right variant; running sessions are hot-switched
 * via the `/e-pi-theme` bridge command. Only defaults are taken over — a
 * theme the user picked in `/settings` stays untouched.
 */
export const AUTO_THEME_SETTING = "e-pi-light/dark";

/** Theme values that are pi defaults or E-Pi's own (E-Pi may manage these). */
const DEFAULT_THEMES = new Set(["dark", "light", "dark/light", "light/dark", "e-pi-light", AUTO_THEME_SETTING]);

export function ensureAutoThemeSetting(): void {
  const raw = readSettingsFile();
  const current = typeof raw.theme === "string" ? raw.theme : undefined;
  if (current === AUTO_THEME_SETTING) return;
  if (current !== undefined && !DEFAULT_THEMES.has(current)) return;
  writeSettingsFile({ ...raw, theme: AUTO_THEME_SETTING });
}

/**
 * E-Pi's contrast-fixed light theme, shipped next to the bridge extension.
 * pi discovers themes from `~/.pi/agent/themes/*.json` at session start, so
 * the file must exist before a session spawns.
 */
export function ensureEpiLightThemeFile(sourceOverride?: string): void {
  const target = join(agentDir(), "themes", "e-pi-light.json");
  const source = sourceOverride ?? epiLightThemeSource();
  try {
    if (readFileSync(target, "utf8").trim() === readFileSync(source, "utf8").trim()) return;
  } catch {
    // Missing target or source — (re)write below.
  }
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(source, "utf8"), "utf8");
  } catch {
    // Theme sync is best-effort; without it light mode falls back to dark.
  }
}

function epiLightThemeSource(): string {
  const packagedPath = typeof process.resourcesPath === "string" ? join(process.resourcesPath, "e-pi-light.json") : "";
  if (app.isPackaged && packagedPath && existsSync(packagedPath)) return packagedPath;
  return join(app.getAppPath(), "resources", "e-pi-light.json");
}
