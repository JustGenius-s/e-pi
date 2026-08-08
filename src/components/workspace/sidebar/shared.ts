import type { Project, SessionSummary } from "../../../types/contracts";

export interface ProjectGroup {
  /** The backing project for multi-folder groups. */
  project?: Project;
  /** Stable group key: the project id, or the cwd for implicit single-folder groups. */
  key: string;
  /** The directory sessions/new sessions use (primary repo for multi-folder projects). */
  cwd: string;
  /** Display name for multi-folder projects. */
  name?: string;
  /** Present for multi-folder projects. */
  primaryRepo?: string;
  /** Present for multi-folder projects; ordered, de-duplicated. */
  folders?: string[];
  sessions: SessionSummary[];
}

/**
 * Per-session callbacks shared by the sidebar rows and the collapsed-mode
 * flyout rows, so both can render the same <SessionRow> component.
 */
export interface SessionRowCallbacks {
  onSelect: (session: SessionSummary) => void;
  onRename: (session: SessionSummary) => void;
  onRemove: (session: SessionSummary) => void;
  /** Restart the session's pi process (e.g. after installing packages). */
  onReload: (session: SessionSummary) => void;
  onOpenFolder: (cwd: string) => void;
  onCopyText: (text: string) => void;
  addToChat: (session: SessionSummary) => void;
  toggleSessionPin: (path: string) => void;
}

/** Pinned session paths and pinned project cwds, in pin order. */
export interface Pins {
  sessions: string[];
  projects: string[];
}

export const PINS_KEY = "sidebar-pins-v1";

export function readPins(): Pins {
  try {
    const raw = window.localStorage.getItem(PINS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Pins>;
      return {
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      };
    }
  } catch {
    // Storage unavailable — start unpinned.
  }
  return { sessions: [], projects: [] };
}

export const UNKNOWN_FOLDER = "Unknown folder";

/** Mid-tone hues for project avatars; dark enough for white letters. */
const PROJECT_AVATAR_COLORS = [
  "oklch(0.58 0.17 25)",
  "oklch(0.57 0.15 120)",
  "oklch(0.56 0.18 240)",
  "oklch(0.55 0.19 300)",
  "oklch(0.6 0.14 85)",
  "oklch(0.55 0.15 180)",
] as const;

/** Deterministic per-project color (stable across renders/sessions). */
export function projectAvatarColor(cwd: string): string {
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) hash = (hash * 31 + cwd.charCodeAt(i)) >>> 0;
  return PROJECT_AVATAR_COLORS[hash % PROJECT_AVATAR_COLORS.length];
}
