import { useCallback, useEffect, useState } from "react";

/**
 * Appearance settings: one base font size (px, unitless) per UI module plus
 * the two xterm terminals. The module bases are written to CSS custom
 * properties (--fs-scale-{module}); every font-size in the app resolves
 * through the role tokens (--fs-*) in theme.css, so a single knob per module
 * rescales its whole subtree without any hand-tuned px anywhere else.
 */

export type AppearanceKey =
  | "sidebar"
  | "workspace"
  | "models"
  | "packages"
  | "git"
  | "skills"
  | "termMain"
  | "termSide";

export interface AppearanceSettings {
  sidebar: number;
  workspace: number;
  models: number;
  packages: number;
  git: number;
  skills: number;
  /** Main workspace terminal font size (xterm, px). */
  termMain: number;
  /** Tool-panel side terminal font size (xterm, px). */
  termSide: number;
}

export const APPEARANCE_DEFAULTS: AppearanceSettings = {
  sidebar: 11,
  workspace: 11,
  models: 11,
  packages: 11,
  git: 11,
  skills: 11,
  termMain: 13,
  termSide: 11,
};

/** Input bounds — keeps any single module from breaking the layout. */
export const APPEARANCE_MIN = 8;
export const APPEARANCE_MAX = 20;

const STORAGE_KEY = "e-pi-appearance";

/** Fired whenever any appearance value changes (settings UI + terminals). */
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to appearance changes; returns an unsubscribe function. */
export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getStoredAppearance(): Partial<AppearanceSettings> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<AppearanceSettings>;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    // Storage unavailable (tests, hardened environments) — use defaults.
    return {};
  }
}

export function getAppearance(): AppearanceSettings {
  const stored = getStoredAppearance();
  return { ...APPEARANCE_DEFAULTS, ...stored };
}

function persist(next: AppearanceSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable — the choice just won't survive a restart.
  }
}

/**
 * Write the module scales to <html> so every --fs-* role token resolves with
 * the stored sizes. Called before React mounts (no flash) and on every change.
 */
export function applyAppearance(): void {
  const { sidebar, workspace, models, packages, git, skills } = getAppearance();
  const root = document.documentElement;
  const vars: Array<[string, string]> = [
    ["--fs-scale-sidebar", String(sidebar)],
    ["--fs-scale-workspace", String(workspace)],
    ["--fs-scale-models", String(models)],
    ["--fs-scale-packages", String(packages)],
    ["--fs-scale-git", String(git)],
    ["--fs-scale-skills", String(skills)],
  ];
  for (const [name, value] of vars) root.style.setProperty(name, value);
}

export function setAppearanceValue(key: AppearanceKey, value: number): void {
  const next = getAppearance();
  const clamped = Math.min(APPEARANCE_MAX, Math.max(APPEARANCE_MIN, Math.round(value)));
  next[key] = clamped;
  persist(next);
  if (key !== "termMain" && key !== "termSide") applyAppearance();
  notify();
}

export function resetAppearance(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  applyAppearance();
  notify();
}

/**
 * Current appearance plus setters. Keeps the settings tab in sync with
 * external changes (another tab's reset, terminal live updates).
 */
export function useAppearance(): {
  appearance: AppearanceSettings;
  set: (key: AppearanceKey, value: number) => void;
  reset: () => void;
} {
  const [appearance, setAppearance] = useState<AppearanceSettings>(() => getAppearance());

  useEffect(() => subscribeAppearance(() => setAppearance(getAppearance())), []);

  const set = useCallback((key: AppearanceKey, value: number) => {
    setAppearanceValue(key, value);
  }, []);

  const reset = useCallback(() => resetAppearance(), []);

  return { appearance, set, reset };
}
