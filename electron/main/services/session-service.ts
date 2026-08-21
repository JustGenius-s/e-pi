import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { app, shell } from "electron";

import { SESSION_NAME_MAX_LENGTH } from "../../../src/lib/format";
import type { ArchivedSessionSummary, SessionSummary } from "../../../src/types/contracts";
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

/** One entry of the archived-sessions index (`archived-sessions.json` in userData). */
interface ArchivedSessionRecord {
  /** Current location of the session file, inside the archived-sessions directory. */
  file: string;
  /** Where the session lived when archived; unarchive moves the file back here. */
  originalPath: string;
  archivedAt: string;
}

interface SessionServiceOptions {
  /** Overrides electron's userData directory for the index file (tests). */
  userDataDir?: string;
}

/**
 * Codex-style session archive. Archiving moves a session's JSONL out of
 * pi's sessions tree (so `SessionManager.listAll()` — and the sidebar — stop
 * seeing it) into a sibling `archived_sessions/` directory, and records the
 * original path in a small index so unarchive can move it straight back.
 * Deleting an archived session goes to the system Trash as a last line of
 * defense. The index lives in userData, written atomically like
 * `projects.json` so a crash can't corrupt it.
 */
export class SessionService {
  #archived: ArchivedSessionRecord[] | undefined;
  #writeChain: Promise<void> = Promise.resolve();
  #userDataDir: string | undefined;

  constructor(options: SessionServiceOptions = {}) {
    this.#userDataDir = options.userDataDir;
  }

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
    if (normalized.length > SESSION_NAME_MAX_LENGTH) {
      throw new Error(`Session name must be ${SESSION_NAME_MAX_LENGTH} characters or fewer.`);
    }

    const { SessionManager } = await loadPiAgent();
    const manager = SessionManager.open(path);
    manager.appendSessionInfo(normalized);
  }

  async getCwd(path: string): Promise<string> {
    const { SessionManager } = await loadPiAgent();
    return SessionManager.open(path).getCwd();
  }

  /**
   * Move a session into the archived-sessions area. The caller is
   * responsible for stopping/forgetting the session's pi process first.
   * Session files are `<agent>/sessions/<encoded-cwd>/<file>.jsonl`, so the
   * archive directory is the `sessions/` sibling (`<agent>/archived_sessions`)
   * — wherever the agent dir is.
   */
  async archive(path: string): Promise<void> {
    await this.#ensureArchivedLoaded();
    if (this.#archived!.some((record) => record.originalPath === path)) {
      throw new Error("Session is already archived.");
    }
    if (!existsSync(path)) throw new Error("Session file not found.");
    const archivedDir = join(dirname(dirname(dirname(path))), "archived_sessions");
    const destination = join(archivedDir, basename(path));
    if (existsSync(destination)) throw new Error("An archived session with the same name already exists.");
    await mkdir(archivedDir, { recursive: true });
    await rename(path, destination);
    this.#archived!.push({ file: destination, originalPath: path, archivedAt: new Date().toISOString() });
    await this.#persistArchived();
  }

  /** Archived sessions, newest first. Missing files are dropped from the index. */
  async listArchived(): Promise<ArchivedSessionSummary[]> {
    await this.#ensureArchivedLoaded();
    const summaries: ArchivedSessionSummary[] = [];
    const next: ArchivedSessionRecord[] = [];
    let pruned = false;
    for (const record of this.#archived!) {
      if (!existsSync(record.file)) {
        pruned = true;
        continue;
      }
      next.push(record);
      const parsed = parseArchivedSessionFile(record.file);
      if (parsed) summaries.push({ ...parsed, originalPath: record.originalPath, archivedAt: record.archivedAt });
    }
    if (pruned) {
      this.#archived = next;
      await this.#persistArchived();
    }
    return summaries.sort(
      (a, b) => b.archivedAt.localeCompare(a.archivedAt) || b.modifiedAt.localeCompare(a.modifiedAt),
    );
  }

  /** Move an archived session back to its original location; it reappears in the sidebar. */
  async unarchive(path: string): Promise<void> {
    await this.#ensureArchivedLoaded();
    const index = this.#archived!.findIndex((record) => record.file === path || record.originalPath === path);
    if (index < 0) throw new Error("Archived session not found.");
    const record = this.#archived![index];
    await mkdir(dirname(record.originalPath), { recursive: true });
    if (existsSync(record.originalPath)) throw new Error("A session already exists at the original location.");
    await rename(record.file, record.originalPath);
    this.#archived!.splice(index, 1);
    await this.#persistArchived();
  }

  /** Permanently delete an archived session: file goes to the system Trash, index entry drops. */
  async deleteArchived(path: string): Promise<void> {
    await this.#ensureArchivedLoaded();
    const index = this.#archived!.findIndex((record) => record.file === path);
    if (index < 0) throw new Error("Archived session not found.");
    const [record] = this.#archived!.splice(index, 1);
    await shell.trashItem(record.file);
    await this.#persistArchived();
  }

  private indexFilePath(): string {
    return join(this.#userDataDir ?? app.getPath("userData"), "archived-sessions.json");
  }

  /** Load once, then keep in memory; the file is only ever written by us. */
  async #ensureArchivedLoaded(): Promise<void> {
    if (this.#archived) return;
    try {
      const raw = await readFile(this.indexFilePath(), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      this.#archived = Array.isArray(parsed)
        ? (parsed as ArchivedSessionRecord[]).filter(
            (record) =>
              record &&
              typeof record.file === "string" &&
              typeof record.originalPath === "string" &&
              typeof record.archivedAt === "string",
          )
        : [];
    } catch {
      this.#archived = [];
    }
  }

  /** Serialized writes; the temp-then-rename swap keeps the file valid on crash. */
  #persistArchived(): Promise<void> {
    const snapshot = JSON.stringify(this.#archived, null, 2);
    this.#writeChain = this.#writeChain.then(async () => {
      const target = this.indexFilePath();
      await mkdir(dirname(target), { recursive: true });
      const tmp = `${target}.tmp`;
      await writeFile(tmp, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(tmp, target);
    });
    return this.#writeChain;
  }
}

interface ParsedArchivedSession {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  createdAt: string;
  modifiedAt: string;
  messageCount: number;
  firstMessage: string;
}

/**
 * Read a session file straight off disk (archived files live outside pi's
 * session tree, so SessionManager can't index them). The format is pi's
 * JSONL: a `session` header line, optional `session_info` lines (name), then
 * `message` lines. Mirrors pi's own `buildSessionInfo`.
 */
function parseArchivedSessionFile(filePath: string): ParsedArchivedSession | undefined {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  let header: Record<string, unknown> | undefined;
  let name: string | undefined;
  let messageCount = 0;
  let firstMessage = "";
  let lastActivityTime: number | undefined;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!header) {
      if (entry.type !== "session" || typeof entry.id !== "string") return undefined;
      header = entry;
      continue;
    }
    if (entry.type === "session_info") {
      if (typeof entry.name === "string" && entry.name.trim()) name = entry.name.trim();
      continue;
    }
    if (entry.type !== "message") continue;
    messageCount++;
    const entryTime = new Date(String(entry.timestamp)).getTime();
    if (Number.isFinite(entryTime)) lastActivityTime = Math.max(lastActivityTime ?? 0, entryTime);
    const message = entry.message as { role?: unknown; content?: unknown } | undefined;
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    const text = extractTextContent(message.content);
    if (text && !firstMessage && message.role === "user") firstMessage = text;
  }
  if (!header) return undefined;
  const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
  const createdAt = Number.isFinite(headerTime) ? new Date(headerTime).toISOString() : new Date().toISOString();
  const modified =
    typeof lastActivityTime === "number" && lastActivityTime > 0
      ? new Date(lastActivityTime)
      : Number.isFinite(headerTime)
        ? new Date(headerTime)
        : undefined;
  return {
    path: filePath,
    id: header.id as string,
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    name,
    createdAt,
    modifiedAt: (modified ?? new Date()).toISOString(),
    messageCount,
    firstMessage: normalizeText(firstMessage || "(no messages)"),
  };
}

/** Join the text blocks of a message payload; mirrors pi's content handling. */
function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text?: string } => Boolean(block) && block.type === "text")
    .map((block) => block.text ?? "")
    .join(" ")
    .trim();
}
