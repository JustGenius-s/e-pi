import { writeFile } from "node:fs/promises";

import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";

import type { SessionSummary } from "../../../src/types/contracts";

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function toSessionSummary(session: SessionInfo): SessionSummary {
  return {
    path: session.path,
    id: session.id,
    cwd: session.cwd,
    name: session.name,
    parentSessionPath: session.parentSessionPath,
    createdAt: session.created.toISOString(),
    modifiedAt: session.modified.toISOString(),
    messageCount: session.messageCount,
    firstMessage: normalizeText(session.firstMessage),
    searchText: normalizeText(
      `${session.name ?? ""} ${session.firstMessage} ${session.allMessagesText} ${session.cwd}`,
    ),
  };
}

export class SessionService {
  async list(): Promise<SessionSummary[]> {
    const sessions = await SessionManager.listAll();
    return sessions.map(toSessionSummary);
  }

  async create(cwd: string): Promise<SessionSummary> {
    const manager = SessionManager.create(cwd);
    const path = manager.getSessionFile();
    if (!path) throw new Error("Pi did not create a persistent session file.");

    const header = manager.getHeader();
    if (!header) throw new Error("Pi did not initialize the session header.");
    await writeFile(path, `${JSON.stringify(header)}\n`, { flag: "wx", mode: 0o600 });

    const sessions = await SessionManager.list(cwd);
    const session = sessions.find((candidate) => candidate.path === path);
    if (!session) throw new Error("The new Pi session could not be indexed.");
    return toSessionSummary(session);
  }

  rename(path: string, name: string): void {
    const normalized = normalizeText(name);
    if (!normalized) throw new Error("Session name cannot be empty.");
    if (normalized.length > 120) throw new Error("Session name must be 120 characters or fewer.");

    const manager = SessionManager.open(path);
    manager.appendSessionInfo(normalized);
  }

  getCwd(path: string): string {
    return SessionManager.open(path).getCwd();
  }
}
