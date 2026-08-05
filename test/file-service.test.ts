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
});
