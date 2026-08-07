import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";

import type {
  EditableTextResult,
  FileContentResult,
  FsErrorCode,
  MentionSearchEntry,
  MentionSearchResult,
  WorkspaceBinaryResult,
  WriteTextExpected,
  WriteTextResult,
} from "../../../src/types/contracts";

/** Directories skipped in the file tree to keep it navigable. */
const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", "out", ".next", "build", "coverage", ".venv", "venv"]);

const MAX_FILE_BYTES = 512 * 1024;
/** Editor/editable read cap; larger files surface as read-only. */
const EDITOR_MAX_BYTES = 1024 * 1024;
/** Preview payload cap (images / pdf). */
const PREVIEW_MAX_BYTES = 32 * 1024 * 1024;
const BINARY_PROBE_BYTES = 8192;
/** Cap for mention search results; UI shows a truncated note beyond this. */
const MENTION_SEARCH_LIMIT = 200;
/** Skip dot-directories and heavy dirs during mention search walks. */
const MENTION_SKIP_DIRS = new Set([...SKIPPED_DIRS, ".", ".."]);

/**
 * Error thrown by the file service; the machine-readable code is embedded in
 * the message as a `[E-PI-FS:CODE]` prefix because Electron's ipc invoke
 * serialization only preserves `Error.message` across the bridge. Renderer
 * code parses it back with `parseFsError` (src/lib/fsErrors.ts).
 */
export class FsBridgeError extends Error {
  readonly code: FsErrorCode;

  constructor(code: FsErrorCode, message: string) {
    super(`[E-PI-FS:${code}] ${message}`);
    this.name = "FsBridgeError";
    this.code = code;
  }
}

function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function countTextLines(text: string): number {
  if (!text) return 0;
  const count = text.split("\n").length;
  // A trailing newline does not open a new (empty) line — editor semantics.
  return text.endsWith("\n") ? count - 1 : count;
}

function isBinaryProbe(buffer: Buffer): boolean {
  return buffer.subarray(0, BINARY_PROBE_BYTES).includes(0);
}

/** Resolve the workspace root and the target path, enforcing confinement. */
function resolveTarget(cwd: string, path: string): { root: string; target: string } {
  const root = resolve(cwd || process.cwd());
  const target = resolve(path);
  if (!isInside(root, target)) {
    throw new FsBridgeError("OUTSIDE_WORKSPACE", "Path is outside the workspace");
  }
  return { root, target };
}

const EXT_MIME: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
  pdf: "application/pdf",
  md: "text/markdown",
  mdx: "text/markdown",
  txt: "text/plain",
  log: "text/plain",
  html: "text/html",
  htm: "text/html",
  json: "application/json",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
};

/** Mime by extension, then by magic bytes, then octet-stream. */
function inferMimeType(path: string, buffer: Buffer): string {
  const extension = extname(path).slice(1).toLowerCase();
  const byExt = EXT_MIME[extension];
  if (byExt) return byExt;
  // Magic bytes for common preview types when the extension is unknown.
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-") {
    return "application/pdf";
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString("latin1") === "GIF87a" || buffer.length >= 6 && buffer.subarray(0, 6).toString("latin1") === "GIF89a") {
    return "image/gif";
  }
  return "application/octet-stream";
}

function relToRoot(root: string, target: string): string {
  return relative(root, target).split(sep).join("/");
}

/** Recursive walk with directory skipping; yields entries as they are found. */
async function walkEntries(
  root: string,
  dir: string,
  onEntry: (entry: MentionSearchEntry, absolute: string) => void,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const name = entry.name;
    if (entry.isDirectory()) {
      if (MENTION_SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      const absolute = resolve(dir, name);
      onEntry({ path: relToRoot(root, absolute), name, kind: "dir" }, absolute);
      await walkEntries(root, absolute, onEntry);
    } else if (entry.isFile()) {
      const absolute = resolve(dir, name);
      onEntry({ path: relToRoot(root, absolute), name, kind: "file" }, absolute);
    }
  }
}

export class FileService {
  /** List a directory (rooted at the session cwd; hidden files are shown). */
  async listDir(cwd: string, path: string): Promise<import("../../../src/types/contracts").FileEntry[]> {
    const { target } = resolveTarget(cwd, path);
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
    const { target } = resolveTarget(cwd, path);
    const info = await stat(target);
    if (info.isDirectory()) throw new Error("Is a directory");
    if (info.size > MAX_FILE_BYTES) {
      throw new Error(`File is too large to preview (${(info.size / 1024).toFixed(0)} KB)`);
    }
    const buffer = await readFile(target);
    const binary = isBinaryProbe(buffer);
    if (binary) return { content: "", truncated: false, binary: true };
    return { content: buffer.toString("utf8"), truncated: false, binary: false };
  }

  /** Versioned text read for the built-in editor. */
  async readEditableText(cwd: string, path: string): Promise<EditableTextResult> {
    const { target } = resolveTarget(cwd, path);
    let info;
    try {
      info = await stat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FsBridgeError("NOT_FOUND", "File does not exist");
      }
      throw error;
    }
    if (info.isDirectory()) throw new FsBridgeError("NOT_FOUND", "Is a directory");
    if (info.size > EDITOR_MAX_BYTES) {
      throw new FsBridgeError(
        "TOO_LARGE",
        `File is too large to edit (${(info.size / 1024).toFixed(0)} KB, limit 1024 KB)`,
      );
    }
    const buffer = await readFile(target);
    if (isBinaryProbe(buffer)) {
      return {
        content: "",
        mtimeMs: info.mtimeMs,
        contentHash: "",
        sizeBytes: buffer.length,
        totalLines: 0,
        binary: true,
      };
    }
    const content = buffer.toString("utf8");
    return {
      content,
      mtimeMs: info.mtimeMs,
      contentHash: sha256Hex(content),
      sizeBytes: buffer.length,
      totalLines: countTextLines(content),
      binary: false,
    };
  }

  /**
   * Versioned write with optimistic concurrency: when `expected` is provided
   * and the file on disk no longer matches the snapshot (mtime or content
   * hash), the write is rejected with STALE_FILE so the UI can offer
   * reload/overwrite instead of silently clobbering external changes.
   */
  async writeText(
    cwd: string,
    path: string,
    content: string,
    expected?: WriteTextExpected,
  ): Promise<WriteTextResult> {
    const { target } = resolveTarget(cwd, path);
    let existing;
    try {
      existing = await stat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      existing = undefined;
    }
    if (existing?.isDirectory()) throw new FsBridgeError("NOT_FOUND", "Is a directory");

    if (expected) {
      if (!existing) {
        throw new FsBridgeError("STALE_FILE", "File was deleted on disk since it was opened");
      }
      const currentHash = sha256Hex((await readFile(target)).toString("utf8"));
      if (expected.contentHash !== undefined && currentHash !== expected.contentHash) {
        throw new FsBridgeError("STALE_FILE", "File changed on disk since it was opened");
      }
      if (expected.mtimeMs !== undefined && Math.abs(existing.mtimeMs - expected.mtimeMs) > 1) {
        throw new FsBridgeError("STALE_FILE", "File changed on disk since it was opened");
      }
    }

    // Atomic write: temp file in the same directory, then rename.
    const temp = resolve(dirname(target), `.e-pi-write-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, content, "utf8");
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }

    const next = await stat(target);
    return {
      mtimeMs: next.mtimeMs,
      contentHash: sha256Hex(content),
      totalLines: countTextLines(content),
      sizeBytes: Buffer.byteLength(content, "utf8"),
    };
  }

  /** Base64 file payload for previews; mime from extension then magic bytes. */
  async readWorkspaceBinary(cwd: string, path: string, maxBytes?: number): Promise<WorkspaceBinaryResult> {
    const { target } = resolveTarget(cwd, path);
    let info;
    try {
      info = await stat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FsBridgeError("NOT_FOUND", "File does not exist");
      }
      throw error;
    }
    if (info.isDirectory()) throw new FsBridgeError("NOT_FOUND", "Is a directory");
    const limit = maxBytes ?? PREVIEW_MAX_BYTES;
    if (info.size > limit) {
      throw new FsBridgeError(
        "TOO_LARGE",
        `File is too large to preview (${(info.size / (1024 * 1024)).toFixed(1)} MB)`,
      );
    }
    const buffer = await readFile(target);
    return {
      mimeType: inferMimeType(path, buffer),
      data: buffer.toString("base64"),
      sizeBytes: buffer.length,
      mtimeMs: info.mtimeMs,
    };
  }

  /** Case-insensitive substring search over workspace paths (file tree search). */
  async mentionSearch(cwd: string, query: string, limit?: number): Promise<MentionSearchResult> {
    const { root } = resolveTarget(cwd, cwd);
    const needle = query.trim().toLowerCase();
    if (!needle) return { entries: [], truncated: false };
    const max = Math.max(1, limit ?? MENTION_SEARCH_LIMIT);
    const matches: MentionSearchEntry[] = [];
    let truncated = false;
    try {
      await walkEntries(root, root, (entry) => {
        if (truncated) return;
        if (entry.name.toLowerCase().includes(needle) || entry.path.toLowerCase().includes(needle)) {
          if (matches.length >= max) {
            truncated = true;
            return;
          }
          matches.push(entry);
        }
      });
    } catch {
      // Walk failures (permission errors on a subtree) degrade to partial results.
    }
    matches.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
    return { entries: matches, truncated };
  }
}
