import type { PiProcessStatus, SessionSummary } from "../types/contracts";

/** User home dir for `~` rendering; set once from app info. */
let homeDir: string | undefined;

export function setHomeDir(path: string): void {
  homeDir = path.replace(/\/+$/, "");
}

/** Render the home directory as `~` (e.g. `/Users/me/proj` → `~/proj`). */
function homePrefixed(path: string): string {
  if (!homeDir || !path.startsWith(homeDir)) return path;
  const rest = path.slice(homeDir.length);
  return rest === "" || rest.startsWith("/") ? `~${rest}` : path;
}

export function compactPath(path: string, max = 38): string {
  const display = homePrefixed(path);
  if (display.length <= max) return display;
  const parts = display.split("/").filter(Boolean);
  if (parts.length < 3) return `...${display.slice(-max + 3)}`;
  return `/${parts[0]}/.../${parts.slice(-2).join("/")}`;
}

export function pathBaseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Compact token count for status displays: 850, 9.4k, 23k, 1.2M. */
export function formatTokens(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

/** Backend hard limit for `sessions.rename` (keep UI in sync). */
export const SESSION_NAME_MAX_LENGTH = 20;

/** Soft cap for titles shown in the sidebar, header, tooltips, and dialogs. */
export const SESSION_TITLE_DISPLAY_MAX = 80;

/** Anything carrying a session name/first message (active or archived). */
export type SessionTitleSource = Pick<SessionSummary, "name" | "firstMessage">;

/** Collapse whitespace and optionally truncate with an ellipsis. */
export function truncateText(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max).trimEnd()}…`;
}

/**
 * Display title: the custom name, else a short first-message preview, else a
 * placeholder. First messages can be multi-KB pastes (skills, manifests); never
 * surface those raw in the chrome.
 */
export function sessionTitle(session: SessionTitleSource): string {
  const named = session.name?.trim();
  if (named) return named;
  return truncateText(session.firstMessage ?? "", SESSION_TITLE_DISPLAY_MAX) || "New session";
}

/**
 * Initial value for the rename dialog. Prefers the custom name; otherwise a
 * whitespace-normalized slice of the first message — never the full paste.
 */
export function sessionRenameDraft(session: SessionTitleSource): string {
  const named = session.name?.trim();
  if (named) return named.slice(0, SESSION_NAME_MAX_LENGTH);
  const draft = (session.firstMessage ?? "").replace(/\s+/g, " ").trim();
  return draft.slice(0, SESSION_NAME_MAX_LENGTH);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function relativeTime(value: string): string {
  const timestamp = new Date(value).getTime();
  const delta = Date.now() - timestamp;
  if (!Number.isFinite(delta) || delta < 60_000) return "just now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function statusLabel(status: PiProcessStatus): string {
  switch (status) {
    case "starting":
      return "Starting Pi";
    case "running":
      return "Session active";
    case "stopping":
      return "Stopping";
    case "exited":
      return "Session closed";
    case "error":
      return "Runtime error";
    default:
      return "Ready";
  }
}

export function statusTone(status: PiProcessStatus): "live" | "busy" | "danger" | "muted" {
  if (status === "running") return "live";
  if (status === "starting" || status === "stopping") return "busy";
  if (status === "error") return "danger";
  return "muted";
}
