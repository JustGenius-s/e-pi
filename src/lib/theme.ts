import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "e-pi-theme";

/** Explicit user choice, or null when the OS setting should be followed. */
export function getStoredTheme(): Theme | null {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // Storage unavailable (tests, hardened environments) — follow the system.
  }
  return null;
}

function getSystemTheme(): Theme {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function resolveTheme(preference: Theme | null): Theme {
  return preference ?? getSystemTheme();
}

export function applyThemeClass(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

/**
 * Apply the initial theme to <html> before React mounts so there is no flash
 * of the wrong theme on startup (stored choice, else the OS setting).
 */
export function applyInitialTheme(): void {
  const theme = resolveTheme(getStoredTheme());
  applyThemeClass(theme);
  // Tell main before React mounts so the first session spawn gets the right
  // COLORFGBG / e-pi-light theme. Otherwise [Skill conflicts] and Update
  // Available bake dark-theme #ffff00 into the transcript.
  void window.ePi?.app.setTheme(theme);
}

/**
 * Current theme plus a toggle. The `dark` class on <html> is the source of
 * truth for the rest of the app (CSS variables, diff viewer, terminals).
 * localStorage records an explicit user choice; without one the app follows
 * the OS setting live. Native chrome (titlebar, scrollbars) is kept in step
 * via the main process.
 */
export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(getStoredTheme()));

  // Follow the OS until the user picks a side.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setTheme(resolveTheme(getStoredTheme()));
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    applyThemeClass(theme);
    if (window.ePi) void window.ePi.app.setTheme(theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage unavailable — the choice just won't survive a restart.
    }
  }, [theme]);

  return { theme, toggleTheme };
}
