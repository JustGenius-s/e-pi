import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
  const merged = { ...readSettingsFile(), ...next };
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2), "utf8");
  return next;
}
