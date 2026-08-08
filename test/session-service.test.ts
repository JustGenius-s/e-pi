import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionService } from "../electron/main/services/session-service";

// The delete-archived path trashes via Electron's shell; tests remove the
// file directly so the archive index is what's under test.
vi.mock("electron", () => ({
  shell: {
    trashItem: vi.fn(async (target: string) => {
      rmSync(target, { recursive: true, force: true });
    }),
  },
}));

/** A minimal pi session JSONL: session header, optional name, then messages. */
function writeSession(
  dir: string,
  fileName: string,
  options: { name?: string; cwd?: string; messages?: string[] } = {},
) {
  const cwd = options.cwd ?? "/work/project-a";
  const lines = [
    JSON.stringify({ type: "session", id: fileName.replace(".jsonl", ""), cwd, timestamp: "2025-01-01T00:00:00.000Z" }),
  ];
  if (options.name) lines.push(JSON.stringify({ type: "session_info", name: options.name }));
  for (const [index, text] of (options.messages ?? ["hello world"]).entries()) {
    lines.push(
      JSON.stringify({
        type: "message",
        timestamp: `2025-01-01T00:0${index + 1}:00.000Z`,
        message: { role: index % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text }] },
      }),
    );
  }
  mkdirSync(dir, { recursive: true });
  const file = join(dir, fileName);
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

describe("SessionService archive", () => {
  const roots: string[] = [];
  let root: string;
  let userDataDir: string;
  let sessionsRoot: string;
  let service: SessionService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "e-pi-archive-"));
    roots.push(root);
    userDataDir = join(root, "user-data");
    sessionsRoot = join(root, "sessions");
    mkdirSync(userDataDir, { recursive: true });
    service = new SessionService({ userDataDir });
  });

  afterAll(() => {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  });

  /** A session file inside the fake sessions tree, as pi lays it out. */
  const archivedDir = () => join(root, "archived_sessions");

  it("moves the session file into archived_sessions and records the original path", async () => {
    const original = writeSession(join(sessionsRoot, "--work-project-a--"), "1700000000000_s1.jsonl");
    expect(existsSync(original)).toBe(true);

    await service.archive(original);

    expect(existsSync(original)).toBe(false);
    const archived = join(archivedDir(), "1700000000000_s1.jsonl");
    expect(existsSync(archived)).toBe(true);
    const index = JSON.parse(readFileSync(join(userDataDir, "archived-sessions.json"), "utf8")) as Array<{
      file: string;
      originalPath: string;
    }>;
    expect(index).toEqual([{ file: archived, originalPath: original, archivedAt: expect.any(String) }]);
  });

  it("lists archived sessions with parsed metadata, newest first", async () => {
    const older = writeSession(join(sessionsRoot, "--work-project-a--"), "1700000000000_older.jsonl", {
      name: "Rust refactor",
      messages: ["hello world", "hi there", "what's up"],
      cwd: "/work/project-a",
    });
    const newer = writeSession(join(sessionsRoot, "--work-project-b--"), "1700000000001_newer.jsonl", {
      messages: ["second project chat"],
      cwd: "/work/project-b",
    });
    await service.archive(older);
    // Distinct archive timestamps so the sort is unambiguous.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await service.archive(newer);

    const archived = await service.listArchived();

    expect(archived.map((session) => session.originalPath)).toEqual([newer, older]);
    const [first] = archived;
    expect(first).toMatchObject({
      cwd: "/work/project-b",
      name: undefined,
      messageCount: 1,
      firstMessage: "second project chat",
    });
    const second = archived[1];
    expect(second).toMatchObject({
      name: "Rust refactor",
      cwd: "/work/project-a",
      messageCount: 3,
      firstMessage: "hello world",
    });
  });

  it("unarchives a session back to its original location and drops the index entry", async () => {
    const original = writeSession(join(sessionsRoot, "--work-project-a--"), "1700000000000_s1.jsonl");
    await service.archive(original);

    await service.unarchive(join(archivedDir(), "1700000000000_s1.jsonl"));

    expect(existsSync(original)).toBe(true);
    expect(existsSync(join(archivedDir(), "1700000000000_s1.jsonl"))).toBe(false);
    expect(await service.listArchived()).toEqual([]);
  });

  it("recreates the original directory when unarchiving", async () => {
    const original = join(sessionsRoot, "--work-project-a--", "1700000000000_s1.jsonl");
    writeSession(dirname(original), "1700000000000_s1.jsonl");
    await service.archive(original);
    rmSync(dirname(original), { recursive: true, force: true });

    await service.unarchive(join(archivedDir(), "1700000000000_s1.jsonl"));

    expect(existsSync(original)).toBe(true);
  });

  it("permanently deletes an archived session via the trash and drops the index entry", async () => {
    const original = writeSession(join(sessionsRoot, "--work-project-a--"), "1700000000000_s1.jsonl");
    await service.archive(original);
    const archivedFile = join(archivedDir(), "1700000000000_s1.jsonl");

    await service.deleteArchived(archivedFile);

    expect(existsSync(archivedFile)).toBe(false);
    expect(await service.listArchived()).toEqual([]);
  });

  it("rejects archiving a missing file or an already-archived session", async () => {
    await expect(service.archive(join(sessionsRoot, "--work-project-a--", "nope.jsonl"))).rejects.toThrow(
      "Session file not found",
    );
    const original = writeSession(join(sessionsRoot, "--work-project-a--"), "1700000000000_s1.jsonl");
    await service.archive(original);
    await expect(service.archive(original)).rejects.toThrow("Session is already archived.");
    await expect(service.unarchive(join(archivedDir(), "missing.jsonl"))).rejects.toThrow("Archived session not found");
  });

  it("drops index entries whose file disappeared on disk", async () => {
    const original = writeSession(join(sessionsRoot, "--work-project-a--"), "1700000000000_s1.jsonl");
    await service.archive(original);
    rmSync(join(archivedDir(), "1700000000000_s1.jsonl"), { force: true });

    const archived = await service.listArchived();

    expect(archived).toEqual([]);
    const index = JSON.parse(readFileSync(join(userDataDir, "archived-sessions.json"), "utf8")) as unknown[];
    expect(index).toEqual([]);
  });

  it("tolerates a corrupted or missing index file", async () => {
    writeFileSync(join(userDataDir, "archived-sessions.json"), "{not json", "utf8");
    expect(await service.listArchived()).toEqual([]);
    // The next archive writes a fresh, valid index.
    const original = writeSession(join(sessionsRoot, "--work-project-a--"), "1700000000000_s1.jsonl");
    await service.archive(original);
    expect(await service.listArchived()).toHaveLength(1);
  });

  it("parses files without a custom name using the first user message", async () => {
    const original = writeSession(join(sessionsRoot, "--work-project-a--"), "1700000000000_s1.jsonl", {
      messages: ["First question", "an answer"],
    });
    await service.archive(original);
    const [archived] = await service.listArchived();
    expect(archived?.firstMessage).toBe("First question");
    expect(archived?.name).toBeUndefined();
  });
});
