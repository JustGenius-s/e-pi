import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileService } from "../electron/main/services/file-service";

describe("FileService", () => {
  let root: string;
  let service: FileService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "e-pi-fs-test-"));
    service = new FileService();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "a.txt"), "hello\n");
    writeFileSync(join(root, "src", "b.ts"), "export const b = 1;\n");
    writeFileSync(join(root, "b.txt"), "world\n");
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules", "x.js"), "skip me\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lists directories first, then files, skipping heavy dirs", async () => {
    const entries = await service.listDir(root, root);
    expect(entries.map((entry) => entry.name)).toEqual(["src", "a.txt", "b.txt"]);
    expect(entries[0]).toMatchObject({ type: "dir" });
    expect(entries[1]).toMatchObject({ type: "file", size: 6 });
  });

  it("reads text files", async () => {
    const result = await service.readFile(root, join(root, "src", "b.ts"));
    expect(result.binary).toBe(false);
    expect(result.content).toBe("export const b = 1;\n");
  });

  it("flags binary files", async () => {
    writeFileSync(join(root, "bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0x41]));
    const result = await service.readFile(root, join(root, "bin.dat"));
    expect(result.binary).toBe(true);
    expect(result.content).toBe("");
  });

  it("rejects files outside the workspace root", async () => {
    await expect(service.readFile(root, "/etc/hosts")).rejects.toThrow("outside");
    await expect(service.listDir(root, "/etc")).rejects.toThrow("outside");
  });

  it("rejects oversized files", async () => {
    writeFileSync(join(root, "big.txt"), "x".repeat(600 * 1024));
    await expect(service.readFile(root, join(root, "big.txt"))).rejects.toThrow("too large");
  });

  it("rejects directories passed to readFile", async () => {
    await expect(service.readFile(root, join(root, "src"))).rejects.toThrow("directory");
  });

  // ── readEditableText ──────────────────────────────────────────────────

  it("reads editable text with version metadata", async () => {
    const result = await service.readEditableText(root, join(root, "src", "b.ts"));
    expect(result.binary).toBe(false);
    expect(result.content).toBe("export const b = 1;\n");
    expect(result.totalLines).toBe(1);
    expect(result.sizeBytes).toBe("export const b = 1;\n".length);
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.mtimeMs).toBeGreaterThan(0);
    expect(result.contentHash).toBe(result.contentHash);
  });

  it("reports binary files as read-only editable content", async () => {
    writeFileSync(join(root, "bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0x41]));
    const result = await service.readEditableText(root, join(root, "bin.dat"));
    expect(result.binary).toBe(true);
    expect(result.content).toBe("");
  });

  it("rejects oversized editable reads with TOO_LARGE", async () => {
    writeFileSync(join(root, "huge.txt"), "x".repeat(1024 * 1024 + 1));
    await expect(service.readEditableText(root, join(root, "huge.txt"))).rejects.toMatchObject({
      code: "TOO_LARGE",
    });
  });

  it("rejects missing editable files with NOT_FOUND", async () => {
    await expect(service.readEditableText(root, join(root, "missing.ts"))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("counts multiline text", async () => {
    writeFileSync(join(root, "lines.txt"), "a\nb\nc");
    const result = await service.readEditableText(root, join(root, "lines.txt"));
    expect(result.totalLines).toBe(3);
  });

  it("counts trailing newline as no extra line", async () => {
    writeFileSync(join(root, "trail.txt"), "a\nb\n");
    const result = await service.readEditableText(root, join(root, "trail.txt"));
    expect(result.totalLines).toBe(2);
  });

  // ── writeText (versioned) ─────────────────────────────────────────────

  it("writes text and returns fresh version metadata", async () => {
    const before = await service.readEditableText(root, join(root, "src", "b.ts"));
    const written = await service.writeText(root, join(root, "src", "b.ts"), "export const b = 2;\n", {
      mtimeMs: before.mtimeMs,
      contentHash: before.contentHash,
    });
    expect(written.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(written.totalLines).toBe(1);
    const after = await service.readEditableText(root, join(root, "src", "b.ts"));
    expect(after.content).toBe("export const b = 2;\n");
    expect(after.contentHash).toBe(written.contentHash);
  });

  it("rejects writes when the content hash went stale", async () => {
    const before = await service.readEditableText(root, join(root, "src", "b.ts"));
    // External modification between read and write.
    writeFileSync(join(root, "src", "b.ts"), "someone else\n");
    await expect(
      service.writeText(root, join(root, "src", "b.ts"), "mine\n", {
        mtimeMs: before.mtimeMs,
        contentHash: before.contentHash,
      }),
    ).rejects.toMatchObject({ code: "STALE_FILE" });
  });

  it("rejects writes when the file was deleted", async () => {
    const before = await service.readEditableText(root, join(root, "src", "b.ts"));
    rmSync(join(root, "src", "b.ts"));
    await expect(
      service.writeText(root, join(root, "src", "b.ts"), "mine\n", {
        contentHash: before.contentHash,
      }),
    ).rejects.toMatchObject({ code: "STALE_FILE" });
  });

  it("allows unversioned writes (force overwrite)", async () => {
    await service.writeText(root, join(root, "src", "b.ts"), "forced\n");
    const after = await service.readEditableText(root, join(root, "src", "b.ts"));
    expect(after.content).toBe("forced\n");
  });

  it("creates new files with versioned writes", async () => {
    const written = await service.writeText(root, join(root, "new.txt"), "fresh\n");
    expect(written.totalLines).toBe(1);
    const after = await service.readEditableText(root, join(root, "new.txt"));
    expect(after.content).toBe("fresh\n");
  });

  it("rejects writes outside the workspace", async () => {
    await expect(service.writeText(root, "/etc/passwd", "pwned\n")).rejects.toMatchObject({
      code: "OUTSIDE_WORKSPACE",
    });
  });

  // ── readWorkspaceBinary ───────────────────────────────────────────────

  it("reads images as base64 with a mime type", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
    writeFileSync(join(root, "pic.png"), png);
    const result = await service.readWorkspaceBinary(root, join(root, "pic.png"));
    expect(result.mimeType).toBe("image/png");
    expect(result.data).toBe(png.toString("base64"));
    expect(result.sizeBytes).toBe(png.length);
  });

  it("detects pdf by magic bytes when the extension is unknown", async () => {
    writeFileSync(join(root, "doc.bin"), Buffer.from("%PDF-1.7 fake"));
    const result = await service.readWorkspaceBinary(root, join(root, "doc.bin"));
    expect(result.mimeType).toBe("application/pdf");
  });

  it("maps markdown extensions to text/markdown", async () => {
    writeFileSync(join(root, "readme.md"), "# Hi");
    const result = await service.readWorkspaceBinary(root, join(root, "readme.md"));
    expect(result.mimeType).toBe("text/markdown");
  });

  it("respects the maxBytes preview cap", async () => {
    writeFileSync(join(root, "big.png"), Buffer.alloc(2048, 1));
    await expect(service.readWorkspaceBinary(root, join(root, "big.png"), 1024)).rejects.toMatchObject({
      code: "TOO_LARGE",
    });
  });

  // ── mentionSearch ─────────────────────────────────────────────────────

  it("finds files by case-insensitive substring", async () => {
    const result = await service.mentionSearch(root, "B.TS");
    expect(result.entries.map((entry) => entry.path)).toEqual(["src/b.ts"]);
    expect(result.entries[0]).toMatchObject({ name: "b.ts", kind: "file" });
  });

  it("returns directories and matches by directory name", async () => {
    const result = await service.mentionSearch(root, "src");
    expect(result.entries.some((entry) => entry.path === "src" && entry.kind === "dir")).toBe(true);
  });

  it("skips heavy and dot directories", async () => {
    const result = await service.mentionSearch(root, "x");
    expect(result.entries.some((entry) => entry.path.startsWith("node_modules"))).toBe(false);
  });

  it("truncates past the limit", async () => {
    const result = await service.mentionSearch(root, "t", 2);
    expect(result.entries.length).toBeLessThanOrEqual(2);
    expect(result.truncated).toBe(true);
  });

  it("returns empty results for a blank query", async () => {
    const result = await service.mentionSearch(root, "  ");
    expect(result.entries).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});
