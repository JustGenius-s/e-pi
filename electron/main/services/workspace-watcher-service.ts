import { watch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import type { WorkspaceChangedEvent } from "../../../src/types/contracts";

/** Directories that should not be watched recursively (noise / volume). */
const WATCH_SKIP_DIRS = new Set([".git", "node_modules", "dist", "out", ".next", "build", "coverage", ".venv", "venv"]);

/** Debounce window for merging fs events into one renderer push. */
const WATCH_MERGE_MS = 300;

type ChangeListener = (event: WorkspaceChangedEvent) => void;

interface WatchedRoot {
  root: string;
  watchers: FSWatcher[];
  /** True when a recursive watcher covers the whole tree. */
  recursive: boolean;
}

/**
 * Per-cwd fs change watcher with debounced event merging. The renderer
 * subscribes through `workspace.onChanged` and receives batches of relative
 * paths every ~300ms, which drives the file tree's subtree refreshes and any
 * other workspace invalidation.
 *
 * Recursive `fs.watch` is supported on macOS, Windows and modern Node on
 * Linux; when the recursive watch fails to start (older platforms), a
 * non-recursive fallback registers one watcher per directory, re-registering
 * directories as they appear.
 */
export class WorkspaceWatcherService {
  private readonly roots = new Map<string, WatchedRoot>();
  private readonly listeners = new Set<ChangeListener>();
  private readonly pending = new Map<string, { paths: Set<string>; timer: NodeJS.Timeout | null }>();

  /** Subscribe to change batches; returns an unsubscribe function. */
  onChanged(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Start watching a cwd (idempotent). */
  watch(cwd: string): void {
    const root = resolve(cwd || process.cwd());
    if (this.roots.has(root)) return;
    const watchers: FSWatcher[] = [];
    try {
      const watcher = watch(root, { recursive: true }, (event, filename) => {
        this.handleChange(root, filename);
      });
      watcher.on("error", () => this.teardown(root));
      watchers.push(watcher);
      this.roots.set(root, { root, watchers, recursive: true });
    } catch {
      this.watchNonRecursive(root, watchers);
    }
  }

  /** Stop watching a cwd. */
  unwatch(cwd: string): void {
    const root = resolve(cwd || process.cwd());
    this.teardown(root);
  }

  /** Drop every watcher (app shutdown). */
  dispose(): void {
    for (const key of [...this.roots.keys()]) this.teardown(key);
    for (const { timer } of this.pending.values()) {
      if (timer !== null) clearTimeout(timer);
    }
    this.pending.clear();
    this.listeners.clear();
  }

  /**
   * Manually report a change for a cwd (e.g. the editor saved a file but no
   * watcher is active for that workspace). Goes through the same merge
   * window so consumers see one consistent event stream.
   */
  notify(cwd: string, paths: string[]): void {
    const root = resolve(cwd || process.cwd());
    const relativePaths = paths
      .map((path) => this.toRelativePath(root, path))
      .filter((path): path is string => path !== null);
    if (relativePaths.length === 0) return;
    this.scheduleFlush(root, relativePaths);
  }

  private handleChange(root: string, filename: string | Buffer | null): void {
    const raw = filename == null ? "" : filename.toString();
    const relativePath = raw ? this.toRelativePath(root, join(root, raw)) : "";
    if (relativePath === null) return;
    this.scheduleFlush(root, relativePath ? [relativePath] : [""]);
  }

  /** Normalize an absolute path to a cwd-relative posix path; null when outside. */
  private toRelativePath(root: string, absolute: string): string | null {
    const resolved = resolve(absolute);
    const rel = relative(root, resolved);
    if (rel.startsWith(`..${sep}`) || rel === "..") return null;
    return rel === "" ? "" : rel.split(sep).join("/");
  }

  /** Merge paths into a per-cwd batch and flush once the window closes. */
  private scheduleFlush(root: string, paths: string[]): void {
    const entry = this.pending.get(root);
    if (entry) {
      for (const path of paths) entry.paths.add(path);
      return;
    }
    const bucket: { paths: Set<string>; timer: NodeJS.Timeout | null } = {
      paths: new Set(paths),
      timer: null,
    };
    bucket.timer = setTimeout(() => {
      this.pending.delete(root);
      const event: WorkspaceChangedEvent = { cwd: root, paths: [...bucket.paths] };
      for (const listener of this.listeners) listener(event);
    }, WATCH_MERGE_MS);
    this.pending.set(root, bucket);
  }

  private teardown(root: string): void {
    const entry = this.roots.get(root);
    if (!entry) return;
    this.roots.delete(root);
    for (const watcher of entry.watchers) watcher.close();
    const pending = this.pending.get(root);
    if (pending) {
      if (pending.timer !== null) clearTimeout(pending.timer);
      this.pending.delete(root);
    }
  }

  /** Non-recursive fallback: one watcher per directory, re-scanning on change. */
  private watchNonRecursive(root: string, watchers: FSWatcher[]): void {
    const registeredDirs = new Set<string>();
    const registerDir = (dir: string): void => {
      if (registeredDirs.has(dir)) return;
      if (WATCH_SKIP_DIRS.has(dir.split(sep).pop() ?? "")) return;
      let watcher: FSWatcher;
      try {
        watcher = watch(dir, (event, filename) => {
          this.handleChange(root, filename);
          // A new directory may have appeared; refresh the watch tree lazily.
          void this.ensureWatchedDirs(root, dir, registeredDirs);
        });
      } catch {
        return;
      }
      watcher.on("error", () => this.teardown(root));
      registeredDirs.add(dir);
      watchers.push(watcher);
    };
    void readdir(root, { withFileTypes: true })
      .then((entries) => {
        registerDir(root);
        for (const entry of entries) {
          if (!entry.isDirectory() || WATCH_SKIP_DIRS.has(entry.name)) continue;
          registerDir(join(root, entry.name));
        }
        this.roots.set(root, { root, watchers, recursive: false });
      })
      .catch(() => {
        this.roots.set(root, { root, watchers, recursive: false });
      });
  }

  /** One-level refresh under `dir` for the non-recursive fallback. */
  private async ensureWatchedDirs(root: string, dir: string, registeredDirs: Set<string>): Promise<void> {
    const entry = this.roots.get(root);
    if (!entry || entry.recursive) return;
    const children = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (!child.isDirectory() || WATCH_SKIP_DIRS.has(child.name)) continue;
      const childDir = join(dir, child.name);
      if (registeredDirs.has(childDir)) continue;
      try {
        const watcher = watch(childDir, (event, filename) => {
          this.handleChange(root, filename);
          void this.ensureWatchedDirs(root, childDir, registeredDirs);
        });
        watcher.on("error", () => undefined);
        registeredDirs.add(childDir);
      } catch {
        // Unreadable directory; skip.
      }
    }
  }
}
