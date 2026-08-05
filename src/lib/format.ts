import type { PiProcessStatus, SessionSummary } from "../types/contracts";

export function compactPath(path: string, max = 38): string {
  if (path.length <= max) return path;
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 3) return `...${path.slice(-max + 3)}`;
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

export function sessionTitle(session: SessionSummary): string {
  return session.name || session.firstMessage || "New session";
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
