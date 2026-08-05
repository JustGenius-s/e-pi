import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import type { FileContentResult } from "../../../src/types/contracts";

/** Directories skipped in the file tree to keep it navigable. */
const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", "out", ".next", "build", "coverage", ".venv", "venv"]);

const MAX_FILE_BYTES = 512 * 1024;
const BINARY_PROBE_BYTES = 8192;

function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

export class FileService {
  /** List a directory (rooted at the session cwd; hidden files are shown). */
  async listDir(cwd: string, path: string): Promise<import("../../../src/types/contracts").FileEntry[]> {
    const root = resolve(cwd || process.cwd());
    const target = resolve(path || root);
    if (!isInside(root, target)) throw new Error("Path is outside the workspace");
    const entries = await readdir(target, { withFileTypes: true });
    const result = await Promise.all(
      entries
        .filter((entry) => !(entry.isDirectory() && SKIPPED_DIRS.has(entry.name)))
        .map(async (entry) => {
          const fullPath = resolve(target, entry.name);
          let size: number | undefined;
          if (entry.isFile()) {
            try {
              size = (await stat(fullPath)).size;
            } catch {
              size = undefined;
            }
          }
          return {
            name: entry.name,
            path: fullPath,
            type: (entry.isDirectory() ? "dir" : "file") as "dir" | "file",
            size,
          };
        }),
    );
    return result.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  /** Read a text file with size and binary protection. */
  async readFile(cwd: string, path: string): Promise<FileContentResult> {
    const root = resolve(cwd || process.cwd());
    const target = resolve(path);
    if (!isInside(root, target)) throw new Error("Path is outside the workspace");
    const info = await stat(target);
    if (info.isDirectory()) throw new Error("Is a directory");
    if (info.size > MAX_FILE_BYTES) {
      throw new Error(`File is too large to preview (${(info.size / 1024).toFixed(0)} KB)`);
    }
    const buffer = await readFile(target);
    const probe = buffer.subarray(0, BINARY_PROBE_BYTES);
    const binary = probe.includes(0);
    if (binary) return { content: "", truncated: false, binary: true };
    return { content: buffer.toString("utf8"), truncated: false, binary: false };
  }
}
