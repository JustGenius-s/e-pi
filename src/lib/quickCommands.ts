/**
 * Quick commands: user-defined one-click prompts. When enabled, the composer
 * shows them as a floating row above the input while it is empty; clicking
 * one sends its prompt directly. Stored in localStorage and shared between
 * the composer and the Settings editor through a module-level store with
 * subscribers (mirrors composerBus). Off by default.
 */

export interface QuickCommand {
  id: string;
  /** Display name, clamped to QUICK_COMMAND_NAME_MAX chars. */
  name: string;
  /** Prompt sent verbatim when the command is clicked. */
  prompt: string;
}

export interface QuickCommandsSettings {
  enabled: boolean;
  commands: QuickCommand[];
}

export const QUICK_COMMAND_NAME_MAX = 10;
export const QUICK_COMMANDS_MAX = 5;
export const QUICK_COMMANDS_STORAGE_KEY = "quick-commands-v1";
export const DEFAULT_QUICK_COMMANDS_SETTINGS: QuickCommandsSettings = { enabled: false, commands: [] };

/** Display names are limited to QUICK_COMMAND_NAME_MAX characters. */
export function clampCommandName(name: string): string {
  return name.slice(0, QUICK_COMMAND_NAME_MAX);
}

/** Validate/coerce untrusted (stored) settings: booleans, string fields, cap the list. */
export function normalizeQuickCommands(value: unknown): QuickCommandsSettings {
  const raw = (value ?? {}) as Partial<QuickCommandsSettings>;
  return {
    enabled: raw.enabled === true,
    commands: (Array.isArray(raw.commands) ? raw.commands : [])
      .filter(
        (command): command is QuickCommand =>
          Boolean(command) &&
          typeof command.id === "string" &&
          typeof command.name === "string" &&
          typeof command.prompt === "string",
      )
      .slice(0, QUICK_COMMANDS_MAX)
      .map((command) => ({ ...command, name: clampCommandName(command.name) })),
  };
}

interface QuickCommandsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Test seam: point the store at a mock instead of window.localStorage. */
let storageOverride: QuickCommandsStorage | undefined;
export function setQuickCommandsStorage(storage: QuickCommandsStorage | undefined): void {
  storageOverride = storage;
}

function resolveStorage(): QuickCommandsStorage | null {
  if (storageOverride) return storageOverride;
  if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  return null;
}

let cached: QuickCommandsSettings | undefined;
const listeners = new Set<() => void>();

export function getQuickCommands(): QuickCommandsSettings {
  if (cached) return cached;
  const store = resolveStorage();
  if (!store) return DEFAULT_QUICK_COMMANDS_SETTINGS;
  try {
    const raw = store.getItem(QUICK_COMMANDS_STORAGE_KEY);
    cached = raw ? normalizeQuickCommands(JSON.parse(raw)) : DEFAULT_QUICK_COMMANDS_SETTINGS;
  } catch {
    // Corrupted storage — fall back to the defaults.
    cached = DEFAULT_QUICK_COMMANDS_SETTINGS;
  }
  return cached;
}

/** Persist new settings and notify every subscriber (composer + settings UI). */
export function updateQuickCommands(next: QuickCommandsSettings): void {
  const normalized = normalizeQuickCommands(next);
  cached = normalized;
  const store = resolveStorage();
  if (store) {
    try {
      store.setItem(QUICK_COMMANDS_STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      // Storage unavailable — the change just won't survive a restart.
    }
  }
  for (const listener of listeners) listener();
}

/** Subscribe to settings changes; returns an unsubscribe function. */
export function subscribeQuickCommands(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: drop the in-memory cache so the next read re-reads storage. */
export function resetQuickCommandsCache(): void {
  cached = undefined;
}
