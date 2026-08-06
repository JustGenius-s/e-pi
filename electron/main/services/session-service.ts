import { writeFile } from "node:fs/promises";

import type { SessionInfo } from "@earendil-works/pi-coding-agent";

import type { SessionSummary } from "../../../src/types/contracts";
import { loadPiAgent } from "./pi-agent-loader";

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
    const { SessionManager } = await loadPiAgent();
    const sessions = await SessionManager.listAll();
    return sessions.map(toSessionSummary);
  }

  async create(cwd: string): Promise<SessionSummary> {
    const { SessionManager } = await loadPiAgent();
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

  async rename(path: string, name: string): Promise<void> {
    const normalized = normalizeText(name);
    if (!normalized) throw new Error("Session name cannot be empty.");
    if (normalized.length > 120) throw new Error("Session name must be 120 characters or fewer.");

    const { SessionManager } = await loadPiAgent();
    const manager = SessionManager.open(path);
    manager.appendSessionInfo(normalized);
  }

  async getCwd(path: string): Promise<string> {
    const { SessionManager } = await loadPiAgent();
    return SessionManager.open(path).getCwd();
  }
}
