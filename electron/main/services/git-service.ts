import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

import type {
  GitCommitMessageResult,
  GitDiffResult,
  GitFileEntry,
  GitNumstat,
  GitOperationResult,
  GitStatus,
} from "../../../src/types/contracts";

const execFileAsync = promisify(execFile);

/**
 * Classify a relative fs.watch event path under the repo root.
 *
 * - "repo": working-tree change (file created/edited/deleted) — refresh.
 * - "git-state": a .git internals change that alters status (index, HEAD, refs, merge/FETCH/ORIG heads, config) — refresh
 *   (with self-trigger guard).
 * - "ignore": neither (node_modules, .git objects/logs/packfiles, …). ".gitignore" edits are repo changes (they affect
 *   untracked filtering).
 */
export function classifyWatchEvent(relativePath: string): "repo" | "git-state" | "ignore" {
  const rel = relativePath.replace(/\\/g, "/");
  if (rel === "") return "repo";
  const segments = rel.split("/");
  if (segments[0] === ".gitignore") return "repo";
  if (segments[0] !== ".git") {
    return segments.some((segment) => segment === "node_modules") ? "ignore" : "repo";
  }
  // Under .git: only index/HEAD/refs/merge-ish heads/config change status.
  const rest = segments.slice(1).join("/");
  if (rest === "") return "git-state";
  if (/^(index|HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|config)$/.test(rest)) return "git-state";
  if (/^refs(\/|$)/.test(rest)) return "git-state";
  return "ignore";
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Upper bound for a single diff payload sent to the renderer / LLM. */
const MAX_DIFF_BYTES = 512 * 1024;
/** Upper bound for the diff excerpt sent to the model for message generation. */
const MAX_GENERATION_BYTES = 48 * 1024;
/** Hunk lines of an untracked file included in the generation context. */
const MAX_UNTRACKED_FILE_LINES = 200;

const COMMIT_PROMPT = `You are an expert software engineer writing a git commit message.

Given the diff below, write a concise, accurate commit message.

Requirements:
- First line is the subject: imperative mood, under 72 characters, conventional commits format (feat, fix, refactor, chore, docs, test, style, perf, build, ci, revert, ...).
- Add a body only when it adds real context: what changed and why, as a short bullet list.
- Match the language of the surrounding code and project; default to English.
- Never mention the diff itself, never add markdown fences, trailers, or file lists.

Output ONLY the commit message.`;

function cleanMessage(raw: string): string {
  let message = raw
    .trim()
    .replace(/^```(?:markdown|text)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  // Drop any line that looks like an AI preamble ("Here is ...", "Subject: ...").
  const lines = message.split("\n");
  while (lines.length > 0) {
    const first = lines[0]!.trim();
    if (first.length === 0 || /^(here(?:'s| is)|subject:|commit message[:：]|sure[,!]?)/i.test(first)) {
      lines.shift();
    } else {
      break;
    }
  }
  message = lines.join("\n").trim();
  return message.slice(0, 8_000);
}

async function runGit(cwd: string, args: string[], timeoutMs = 60_000): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 4 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? String(error),
      code: failure.code ?? 1,
    };
  }
}

/** Parse `git status --porcelain=v1 -z` into entries with proper rename handling. */
function parsePorcelain(output: string): GitFileEntry[] {
  const parts = output.split("\0");
  const entries: GitFileEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    // Each entry is "XY <path>" — status letters, space separator, path.
    if (part.length < 4) continue;
    const status = part.slice(0, 2);
    let path = part.slice(3);
    if ((status[0] === "R" || status[0] === "C") && i + 1 < parts.length) {
      // Renames/copies are followed by the old path as a bare field.
      const candidate = parts[i + 1];
      if (candidate && candidate.length > 0 && !/^[ MADRCU?!]{2} /.test(candidate)) {
        i++;
        path = `${candidate} -> ${path}`;
      }
    }
    entries.push({
      path,
      workPath: part.slice(3),
      status,
      staged: status[0] !== " " && status[0] !== "?",
      untracked: status === "??",
      conflict: status.includes("U") || status === "AA" || status === "DD",
    });
  }
  return entries;
}

function parseUpstreamLine(line: string): { upstream?: string; ahead: number; behind: number } {
  // e.g. "## main...origin/main [ahead 1, behind 2]" or "## main...origin/main"
  const match = line.match(/^##\s+([^\s[.]+)(?:\.\.\.([^\s[]+))?(?:\s+\[(.*)\])?/);
  if (!match) return { ahead: 0, behind: 0 };
  const upstream = match[2] || undefined;
  const flags = match[3] ?? "";
  const ahead = /ahead (\d+)/.exec(flags)?.[1] ? Number(/ahead (\d+)/.exec(flags)![1]) : 0;
  const behind = /behind (\d+)/.exec(flags)?.[1] ? Number(/behind (\d+)/.exec(flags)![1]) : 0;
  return { upstream, ahead, behind };
}

/**
 * Line-change stats for every changed file without loading full diffs.
 * Tracked files come from `git diff --numstat`; untracked files are counted
 * from disk (additions = line count). Binary files report 0/0.
 */
async function numstatForFiles(cwd: string, files: GitFileEntry[]): Promise<Record<string, GitNumstat>> {
  const numstat: Record<string, GitNumstat> = {};
  const tracked = files.filter((file) => !file.untracked);
  if (tracked.length > 0) {
    const result = await runGit(cwd, ["diff", "--numstat", "-z", "--no-color", "HEAD", "--"]);
    // -z format: "<add>\t<del>\t<path>\0" per file; renames append "<old>\0".
    const parts = result.stdout.split("\0");
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const match = /^(\d+)\t(\d+)\t(.*)$/s.exec(part ?? "");
      if (!match) continue;
      const additions = Number(match[1]);
      const deletions = Number(match[2]);
      let path = match[3] ?? "";
      // Rename/copy: the next field holds the old path; skip it.
      const next = parts[i + 1];
      if (next !== undefined && !/^\d+\t\d+\t/.test(next)) i++;
      if (path) numstat[path] = { additions, deletions };
    }
  }
  await Promise.all(
    files
      .filter((file) => file.untracked)
      .map(async (file) => {
        try {
          const buffer = await readFile(join(cwd, file.workPath));
          const additions = buffer.includes(0) ? 0 : countLines(buffer);
          numstat[file.workPath] = { additions, deletions: 0 };
        } catch {
          // File vanished between status and stat; leave it unset.
        }
      }),
  );
  return numstat;
}

function countLines(buffer: Buffer): number {
  let count = 0;
  for (const byte of buffer) if (byte === 0x0a) count++;
  // A trailing newline is conventional; count a final unterminated line too.
  if (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a) count++;
  return count;
}

/** Diff text for a single file: worktree + index vs HEAD; untracked files render as new files. */
async function diffForFile(cwd: string, entry: GitFileEntry): Promise<GitDiffResult> {
  let stdout: string;
  let truncated = false;
  if (entry.untracked) {
    const result = await runGit(cwd, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-index",
      "/dev/null",
      entry.workPath,
    ]);
    stdout = result.stdout; // exit code 1 is the normal "differences found" signal
  } else {
    const result = await runGit(cwd, ["diff", "--no-color", "--no-ext-diff", "HEAD", "--", entry.workPath]);
    stdout = result.stdout;
  }
  if (Buffer.byteLength(stdout, "utf8") > MAX_DIFF_BYTES) {
    stdout = `${stdout.slice(0, MAX_DIFF_BYTES)}\n[diff truncated]\n`;
    truncated = true;
  }
  return { path: entry.path, diff: stdout, truncated };
}

export class GitService {
  #watcher: FSWatcher | undefined;
  #watchedCwd: string | undefined;
  #onChange: ((cwd: string) => void) | undefined;
  #watchTimer: NodeJS.Timeout | undefined;
  #watchFirstEvent = 0;
  /** When the last `status()` finished; .git events shortly after are self-generated. */
  #lastStatusAt = 0;

  /**
   * Start watching a repo for status-affecting changes. At most one repo is
   * watched at a time; calling with a new cwd replaces the previous watch.
   * Changes are debounced (trailing 600ms, hard 2s cap) and reported via
   * `onChange(cwd)`. Watching is best-effort: if it fails, callers keep the
   * existing agent-activity/action refreshes.
   */
  async watch(cwd: string, onChange: (cwd: string) => void): Promise<void> {
    if (this.#watchedCwd === cwd && this.#onChange === onChange && this.#watcher) return;
    this.unwatch();
    this.#watchedCwd = cwd;
    this.#onChange = onChange;
    // Watch the repo root, not the session's subdir, so the whole repo and
    // its .git are covered even when the workspace is a subdirectory.
    const root = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    if (this.#watchedCwd !== cwd) return; // superseded by a newer watch()
    const rootPath = root.code === 0 && root.stdout.trim() ? root.stdout.trim() : cwd;
    try {
      this.#watcher = watch(rootPath, { recursive: true }, (_event, filename) => {
        this.#onWatchEvent(filename);
      });
    } catch {
      this.#watcher = undefined;
    }
  }

  unwatch(cwd?: string): void {
    if (cwd !== undefined && cwd !== this.#watchedCwd) return;
    if (this.#watchTimer) {
      clearTimeout(this.#watchTimer);
      this.#watchTimer = undefined;
    }
    this.#watcher?.close();
    this.#watcher = undefined;
    this.#watchedCwd = undefined;
    this.#onChange = undefined;
  }

  #onWatchEvent(filename: string | null): void {
    const kind = classifyWatchEvent(filename ?? "");
    if (kind === "ignore") return;
    // Our own refresh() runs git status, which can rewrite .git/index;
    // ignore .git events shortly after a status to avoid a refresh loop.
    if (kind === "git-state" && Date.now() - this.#lastStatusAt < 1_500) return;
    this.#scheduleWatchFire();
  }

  /** Trailing debounce; keep refreshing during continuous changes (max ~2s apart). */
  #scheduleWatchFire(): void {
    const now = Date.now();
    if (this.#watchFirstEvent === 0) this.#watchFirstEvent = now;
    if (this.#watchTimer) clearTimeout(this.#watchTimer);
    const elapsed = now - this.#watchFirstEvent;
    const delay = elapsed >= 2_000 ? 0 : Math.max(600 - elapsed, 0);
    this.#watchTimer = setTimeout(() => this.#fireWatch(), delay);
  }

  #fireWatch(): void {
    this.#watchTimer = undefined;
    this.#watchFirstEvent = 0;
    const cwd = this.#watchedCwd;
    if (cwd) this.#onChange?.(cwd);
  }

  async status(cwd: string): Promise<GitStatus> {
    const root = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    if (root.code !== 0 || !root.stdout.trim()) {
      throw new Error("Not a git repository");
    }
    const branch = (await runGit(cwd, ["branch", "--show-current"])).stdout.trim();
    const summary = await runGit(cwd, ["status", "-sb"]);
    const firstLine = summary.stdout.split("\n")[0] ?? "";
    const { upstream, ahead, behind } = parseUpstreamLine(firstLine);
    const porcelain = await runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const files = parsePorcelain(porcelain.stdout);

    let stagedCount = 0;
    let unstagedCount = 0;
    let untrackedCount = 0;
    for (const file of files) {
      if (file.untracked) untrackedCount++;
      else if (file.staged) stagedCount++;
      if (!file.untracked && file.status[1] !== " " && file.status[1] !== "?") unstagedCount++;
    }
    const numstat = await numstatForFiles(cwd, files);

    this.#lastStatusAt = Date.now();
    return {
      repoRoot: root.stdout.trim(),
      branch,
      upstream,
      ahead,
      behind,
      files,
      stagedCount,
      unstagedCount,
      untrackedCount,
      numstat,
    };
  }

  async diff(cwd: string, path: string): Promise<GitDiffResult> {
    const status = await this.status(cwd);
    const entry = status.files.find((file) => file.workPath === path || file.path === path);
    if (!entry) return { path, diff: "", truncated: false };
    return diffForFile(cwd, entry);
  }

  async stage(cwd: string, paths: string[]): Promise<GitOperationResult> {
    // Empty paths = stage everything (including untracked files).
    const args = paths.length > 0 ? ["add", "--", ...paths] : ["add", "-A"];
    const result = await runGit(cwd, args);
    return result.code === 0
      ? { ok: true, message: paths.length > 0 ? `Staged ${paths.length} file(s)` : "Staged all changes" }
      : { ok: false, message: result.stderr.trim() || "git add failed" };
  }

  async unstage(cwd: string, paths: string[]): Promise<GitOperationResult> {
    const args = paths.length > 0 ? ["restore", "--staged", "--", ...paths] : ["reset", "-q"];
    const result = await runGit(cwd, args);
    return result.code === 0
      ? { ok: true, message: paths.length > 0 ? `Unstaged ${paths.length} file(s)` : "Unstaged all changes" }
      : { ok: false, message: result.stderr.trim() || "git unstage failed" };
  }

  async commit(cwd: string, message: string): Promise<GitOperationResult> {
    const trimmed = message.trim();
    if (!trimmed) return { ok: false, message: "Commit message is empty" };
    const dir = await mkdtemp(join(tmpdir(), "e-pi-commit-"));
    const filePath = join(dir, "message.txt");
    try {
      await writeFile(filePath, trimmed, "utf8");
      const result = await runGit(cwd, ["commit", "-F", filePath, "-q"]);
      if (result.code !== 0) return { ok: false, message: result.stderr.trim() || "git commit failed" };
      const shortHash = (await runGit(cwd, ["rev-parse", "--short", "HEAD"])).stdout.trim();
      return {
        ok: true,
        message: `Committed ${shortHash || ""}${trimmed.split("\n")[0] ? `: ${trimmed.split("\n")[0]}` : ""}`.trim(),
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async push(cwd: string): Promise<GitOperationResult> {
    const branch = (await runGit(cwd, ["branch", "--show-current"])).stdout.trim();
    const upstream = await runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    const args = upstream.code === 0 ? ["push"] : ["push", "-u", "origin", branch];
    const result = await runGit(cwd, args, 120_000);
    if (result.code !== 0) {
      return { ok: false, message: result.stderr.trim() || result.stdout.trim() || "git push failed" };
    }
    const pushed = result.stdout.trim() || result.stderr.trim();
    return {
      ok: true,
      message: upstream.code === 0 ? pushed || "Pushed" : `Pushed ${branch} and set upstream to origin/${branch}`,
    };
  }

  async pull(cwd: string): Promise<GitOperationResult> {
    const result = await runGit(cwd, ["pull"], 120_000);
    if (result.code !== 0) {
      return { ok: false, message: result.stderr.trim() || result.stdout.trim() || "git pull failed" };
    }
    const pulled = result.stdout.trim() || result.stderr.trim();
    return { ok: true, message: pulled || "Pulled" };
  }

  /** Generate a commit message from the current diff using the default pi model. */
  async generateMessage(cwd: string, stagedOnly: boolean): Promise<GitCommitMessageResult> {
    const diffArgs = stagedOnly ? ["diff", "--no-color", "--cached"] : ["diff", "--no-color", "HEAD"];
    const diff = await runGit(cwd, diffArgs, 30_000);

    let context = diff.stdout;
    if (!stagedOnly) {
      // Untracked files are invisible to `git diff HEAD`; include a bounded excerpt.
      const untracked = await runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
      const names = untracked.stdout.split("\0").filter(Boolean);
      if (names.length > 0) {
        const sections = await Promise.all(
          names.map(async (name) => {
            try {
              const content = await readFile(join(cwd, name), "utf8");
              const lines = content.split("\n").slice(0, MAX_UNTRACKED_FILE_LINES);
              return `--- untracked file: ${name}\n${lines.map((line) => `+${line}`).join("\n")}`;
            } catch {
              return `--- untracked file: ${name} (binary or unreadable)`;
            }
          }),
        );
        context = `${context}\n${sections.join("\n\n")}`;
      }
    }

    if (!context.trim()) {
      throw new Error("No changes to describe");
    }
    if (Buffer.byteLength(context, "utf8") > MAX_GENERATION_BYTES) {
      context = `${context.slice(0, MAX_GENERATION_BYTES)}\n[diff truncated]\n`;
    }

    const runtime = await ModelRuntime.create({ allowModelNetwork: false });
    const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: true });
    const providerId = settings.getDefaultProvider();
    const modelId = settings.getDefaultModel();
    const model = providerId && modelId ? runtime.getModel(providerId, modelId) : undefined;
    if (!model) {
      throw new Error("No default model configured — pick one in Model settings first");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await runtime.complete(
        model,
        {
          systemPrompt: COMMIT_PROMPT,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: context }],
              timestamp: Date.now(),
            },
          ],
        },
        { signal: controller.signal },
      );

      const content = response.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      const message = cleanMessage(content);
      if (!message) throw new Error("The model returned an empty commit message");
      return { message, model: `${model.provider}/${model.id}` };
    } finally {
      clearTimeout(timeout);
    }
  }
}
