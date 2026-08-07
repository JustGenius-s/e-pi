import { useCallback, useEffect, useState } from "react";

/**
 * Built-in editor settings: code font size and code theme. Stored in
 * localStorage like the appearance settings; the editor overlay consumes
 * them through useEditorSettings and reconfigures CodeMirror live.
 */

export type EditorThemeChoice = "system" | "light" | "dark";

export interface EditorSettings {
  /** CodeMirror font size in px. */
  fontSize: number;
  /** Code theme; "system" follows the app (OS) theme. */
  theme: EditorThemeChoice;
}

export const EDITOR_SETTINGS_DEFAULTS: EditorSettings = {
  fontSize: 13,
  theme: "system",
};

/** Input bounds — keeps the editor readable without breaking the layout. */
export const EDITOR_FONT_MIN = 9;
export const EDITOR_FONT_MAX = 24;

const STORAGE_KEY = "e-pi-editor-settings";

/** Fired whenever any editor setting changes. */
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to editor setting changes; returns an unsubscribe function. */
export function subscribeEditorSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getEditorSettings(): EditorSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EDITOR_SETTINGS_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<EditorSettings>;
    return {
      fontSize:
        typeof parsed.fontSize === "number" && Number.isFinite(parsed.fontSize)
          ? Math.min(EDITOR_FONT_MAX, Math.max(EDITOR_FONT_MIN, Math.round(parsed.fontSize)))
          : EDITOR_SETTINGS_DEFAULTS.fontSize,
      theme: parsed.theme === "light" || parsed.theme === "dark" ? parsed.theme : EDITOR_SETTINGS_DEFAULTS.theme,
    };
  } catch {
    return { ...EDITOR_SETTINGS_DEFAULTS };
  }
}

export function setEditorSettings(patch: Partial<EditorSettings>): EditorSettings {
  const next = { ...getEditorSettings(), ...patch };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable — the choice just won't survive a restart.
  }
  notify();
  return next;
}

/** React hook: current editor settings, live-updating. */
export function useEditorSettings(): {
  settings: EditorSettings;
  setFontSize: (fontSize: number) => void;
  setTheme: (theme: EditorThemeChoice) => void;
} {
  const [settings, setSettings] = useState<EditorSettings>(getEditorSettings);

  useEffect(() => {
    const sync = () => setSettings(getEditorSettings());
    sync();
    return subscribeEditorSettings(sync);
  }, []);

  const setFontSize = useCallback((fontSize: number) => {
    setEditorSettings({ fontSize });
  }, []);
  const setTheme = useCallback((theme: EditorThemeChoice) => {
    setEditorSettings({ theme });
  }, []);

  return { settings, setFontSize, setTheme };
}
