import {
  ArrowDownToLine,
  ArrowUp,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Folders,
  GitBranch,
  GitCommitHorizontal,
  ListChevronsDownUp,
  ListChevronsUpDown,
  Sparkles,
  Square,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { pathBaseName } from "../lib/format";
import type { GitDiffResult, GitFileEntry, GitStatus } from "../types/contracts";
import { IconButton } from "./IconButton";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Textarea } from "./ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface ReviewViewProps {
  cwd: string;
}

type Phase = "idle" | "generating" | "committing" | "pushing" | "pulling";

function fileStatusLabel(entry: GitFileEntry): string {
  if (entry.conflict) return "conflict";
  if (entry.untracked) return "untracked";
  if (entry.staged) return "staged";
  return "modified";
}

function statusIcon(entry: GitFileEntry): string {
  if (entry.conflict) return "!";
  if (entry.untracked) return "?";
  if (entry.staged && entry.status[1] === " ") return "A";
  if (entry.staged) return "M";
  return entry.status[1] === "D" ? "D" : "M";
}

function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git") || line.startsWith("index ")) {
    return "git-diff-meta";
  }
  if (line.startsWith("@@")) return "git-diff-hunk";
  if (line.startsWith("+")) return "git-diff-add";
  if (line.startsWith("-")) return "git-diff-del";
  return "";
}

/** Memoized diff body: re-rendering App must not re-parse the diff text. */
const DiffView = memo(function DiffView({ result }: { result: GitDiffResult }) {
  const lines = useMemo(() => result.diff.split("\n"), [result.diff]);
  if (!result.diff) {
    return <div className="git-diff-empty">No changes for this file</div>;
  }
  return (
    <div className="git-diff">
      {lines.map((line, index) => {
        const rowKey = `${index}:${line}`;
        return (
          <div key={rowKey} className={diffLineClass(line)}>
            {line || " "}
          </div>
        );
      })}
      {result.truncated ? <div className="git-diff-truncated">Diff truncated for display</div> : null}
    </div>
  );
});

interface FileSectionProps {
  entry: GitFileEntry;
  expanded: boolean;
  diff: GitDiffResult | undefined;
  diffError: string | undefined;
  loading: boolean;
  onToggle: () => void;
  onToggleStage: (entry: GitFileEntry) => void;
  sectionRef: (el: HTMLDivElement | null) => void;
}

/**
 * One changed file: a header row (stage checkbox, name, directory) that
 * expands/collapses its diff body below it.
 */
const FileSection = memo(function FileSection({
  entry,
  expanded,
  diff,
  diffError,
  loading,
  onToggle,
  onToggleStage,
  sectionRef,
}: FileSectionProps) {
  const lastSlash = entry.path.lastIndexOf("/");
  const dir = lastSlash >= 0 ? entry.path.slice(0, lastSlash + 1) : "";
  return (
    <div className="git-file-section" ref={sectionRef}>
      <div
        role="option"
        aria-selected={expanded}
        aria-expanded={expanded}
        className={`git-file${expanded ? " expanded" : ""}`}
        onClick={onToggle}
      >
        <span className="git-file-chevron">
          <ChevronRight size={11} className={expanded ? "rotated" : ""} />
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className={`git-file-stage git-file-stage-${fileStatusLabel(entry)}`}
              aria-label={`${entry.staged ? "Unstage" : "Stage"} ${pathBaseName(entry.workPath)}`}
              onClick={(event) => {
                event.stopPropagation();
                onToggleStage(entry);
              }}
            >
              {entry.staged ? <CheckSquare size={12} /> : <Square size={12} />}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {statusIcon(entry)} {fileStatusLabel(entry)}
          </TooltipContent>
        </Tooltip>
        <span className="git-file-name" title={entry.path}>
          {pathBaseName(entry.path)}
        </span>
        {dir ? <span className="git-file-dir">{dir}</span> : null}
      </div>
      {expanded ? (
        <div className="git-diff-wrap">
          {loading ? (
            <div className="git-diff-empty">加载中…</div>
          ) : diffError ? (
            <div className="git-diff-error">{diffError}</div>
          ) : diff ? (
            <DiffView result={diff} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

/**
 * Right-hand Git panel: all changed files laid out flat, each expanding to
 * its diff; a floating file-tree card (top-right, below the meta bar) jumps
 * to a file. Commit/push live in a dialog opened from the top-bar combo
 * button; pull runs directly from its menu.
 */
export const ReviewView = memo(function ReviewView({ cwd }: ReviewViewProps) {
  const [status, setStatus] = useState<GitStatus>();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [diffs, setDiffs] = useState<Record<string, GitDiffResult>>({});
  const [diffErrors, setDiffErrors] = useState<Record<string, string>>({});
  const [loadingPaths, setLoadingPaths] = useState<ReadonlySet<string>>(new Set());
  const [showTree, setShowTree] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const lastAutoRefresh = useRef(0);
  const previousActivity = useRef<string>("idle");
  const loadingRef = useRef(new Set<string>());
  const cwdRef = useRef(cwd);
  const sectionRefs = useRef(new Map<string, HTMLDivElement>());
  const pendingScroll = useRef<string | undefined>(undefined);

  useEffect(() => {
    cwdRef.current = cwd;
  }, [cwd]);

  const refresh = useCallback(async () => {
    if (!cwd) return;
    setError(undefined);
    try {
      const next = await window.ePi.git.status(cwd);
      setStatus(next);
    } catch (reason) {
      setStatus(undefined);
      setDiffs({});
      setDiffErrors({});
      setExpanded(new Set());
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [cwd]);

  // Load on cwd change; reset per-repo state.
  useEffect(() => {
    setMessage("");
    setNotice(undefined);
    setExpanded(new Set());
    setDiffs({});
    setDiffErrors({});
    void refresh();
  }, [cwd, refresh]);

  // Auto-refresh when the session's pi process goes busy -> idle (agent just
  // finished editing files), throttled to once per 2 seconds.
  useEffect(() => {
    if (!cwd) return;
    return window.ePi.runtime.onState((state) => {
      if (state.cwd !== cwd) return;
      const wasBusy = previousActivity.current === "busy";
      previousActivity.current = state.activity ?? "idle";
      if (!wasBusy || state.activity !== "idle") return;
      const now = Date.now();
      if (now - lastAutoRefresh.current < 2_000) return;
      lastAutoRefresh.current = now;
      void refresh();
    });
  }, [cwd, refresh]);

  /** Fetch a file's diff once; results are cached in state keyed by path. */
  const loadDiff = useCallback(
    (path: string) => {
      if (loadingRef.current.has(path)) return;
      loadingRef.current.add(path);
      setLoadingPaths(new Set(loadingRef.current));
      const repoCwd = cwd;
      void window.ePi.git
        .diff(repoCwd, path)
        .then((result) => {
          if (cwdRef.current !== repoCwd) return;
          setDiffs((current) => ({ ...current, [path]: result }));
        })
        .catch((reason: unknown) => {
          if (cwdRef.current !== repoCwd) return;
          setDiffErrors((current) => ({
            ...current,
            [path]: reason instanceof Error ? reason.message : String(reason),
          }));
        })
        .finally(() => {
          loadingRef.current.delete(path);
          setLoadingPaths(new Set(loadingRef.current));
        });
    },
    [cwd],
  );

  const toggleFile = (entry: GitFileEntry) => {
    const path = entry.workPath;
    const willExpand = !expanded.has(path);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (willExpand) loadDiff(path);
  };

  const allExpanded =
    status !== undefined && status.files.length > 0 && status.files.every((file) => expanded.has(file.workPath));

  /** Collapse all sections when everything is expanded, else expand all. */
  const toggleAll = () => {
    if (!status) return;
    const next = new Set<string>();
    if (!allExpanded) {
      for (const file of status.files) {
        next.add(file.workPath);
        loadDiff(file.workPath);
      }
    }
    setExpanded(next);
  };

  /** Card click: expand the section if collapsed, then scroll it into view. */
  const selectFromTree = (path: string) => {
    if (!expanded.has(path)) {
      const entry = status?.files.find((file) => file.workPath === path);
      if (entry) toggleFile(entry);
      pendingScroll.current = path;
      return;
    }
    sectionRefs.current.get(path)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Scroll to the pending card target once the expand above has rendered.
  useEffect(() => {
    if (!pendingScroll.current) return;
    const path = pendingScroll.current;
    pendingScroll.current = undefined;
    sectionRefs.current.get(path)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [expanded]);

  const toggleStage = async (entry: GitFileEntry) => {
    if (!cwd) return;
    setError(undefined);
    const result = entry.staged
      ? await window.ePi.git.unstage(cwd, [entry.workPath])
      : await window.ePi.git.stage(cwd, [entry.workPath]);
    if (!result.ok) setError(result.message);
    else setNotice(result.message);
    await refresh();
  };

  const stageAll = async () => {
    if (!cwd) return;
    setError(undefined);
    const result = await window.ePi.git.stage(cwd, []);
    if (!result.ok) setError(result.message);
    else setNotice(result.message);
    await refresh();
  };

  const unstageAll = async () => {
    if (!cwd) return;
    setError(undefined);
    const result = await window.ePi.git.unstage(cwd, []);
    if (!result.ok) setError(result.message);
    else setNotice(result.message);
    await refresh();
  };

  const generate = async () => {
    if (!cwd || !status) return;
    setPhase("generating");
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await window.ePi.git.generateMessage(cwd, status.stagedCount > 0);
      setMessage(result.message);
      setNotice(`Commit message generated with ${result.model}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPhase("idle");
    }
  };

  const commit = async () => {
    if (!cwd || !message.trim()) return;
    if (!status || status.stagedCount === 0) {
      setError("Nothing staged — stage files first");
      return;
    }
    setPhase("committing");
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await window.ePi.git.commit(cwd, message);
      if (!result.ok) setError(result.message);
      else {
        setNotice(result.message);
        setMessage("");
        setDialogOpen(false);
      }
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPhase("idle");
    }
  };

  const push = async () => {
    if (!cwd) return;
    setPhase("pushing");
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await window.ePi.git.push(cwd);
      if (!result.ok) setError(result.message);
      else setNotice(result.message);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPhase("idle");
    }
  };

  const pull = async () => {
    if (!cwd) return;
    setPhase("pulling");
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await window.ePi.git.pull(cwd);
      if (!result.ok) setError(result.message);
      else setNotice(result.message);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPhase("idle");
    }
  };

  const busy = phase !== "idle";

  return (
    <div className="git-panel-body">
      {/* Top bar: branch info + actions (all on the right). */}
      <div className="git-review-meta">
        {status?.branch ? <GitBranch size={12} /> : null}
        {status?.branch ? <strong>{status.branch}</strong> : null}
        {status?.branch && status.upstream ? (
          <span>
            {status.upstream}
            {status.ahead > 0 || status.behind > 0 ? (
              <em>
                {status.ahead > 0 ? ` ↑${status.ahead}` : ""}
                {status.behind > 0 ? ` ↓${status.behind}` : ""}
              </em>
            ) : null}
          </span>
        ) : null}
        <div className="git-review-actions">
          <IconButton
            label={allExpanded ? "全部折叠" : "全部展开"}
            onClick={toggleAll}
            disabled={!status || status.files.length === 0}
          >
            {allExpanded ? <ListChevronsDownUp size={14} /> : <ListChevronsUpDown size={14} />}
          </IconButton>
          <IconButton
            label={showTree ? "隐藏文件树" : "显示文件树"}
            className={showTree ? "active" : ""}
            onClick={() => setShowTree((current) => !current)}
          >
            <Folders size={14} />
          </IconButton>
          <div className="git-combo">
            <button type="button" className="git-combo-primary" onClick={() => setDialogOpen(true)}>
              <GitCommitHorizontal size={13} />
              提交
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="git-combo-caret" aria-label="更多 Git 操作">
                  <ChevronDown size={12} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={4}>
                <DropdownMenuItem onSelect={() => setDialogOpen(true)}>
                  <GitCommitHorizontal size={13} />
                  提交或推送
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void pull()} disabled={busy}>
                  <ArrowDownToLine size={13} />
                  拉取代码
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {notice || busy ? (
        <div className="git-status-strip">
          {notice ? <span className="git-notice">{notice}</span> : null}
          {phase === "generating" ? <span className="git-busy">Generating commit message with pi…</span> : null}
          {phase === "pulling" ? <span className="git-busy">Pulling…</span> : null}
        </div>
      ) : null}

      {error ? (
        <div className="git-error" role="alert">
          {error}
        </div>
      ) : null}

      {status ? (
        <div className="git-main">
          <div className="git-files" role="listbox" aria-label="Changed files">
            {status.files.length === 0 ? (
              <div className="git-empty">Working tree clean</div>
            ) : (
              status.files.map((entry) => (
                <FileSection
                  key={entry.workPath}
                  entry={entry}
                  expanded={expanded.has(entry.workPath)}
                  diff={diffs[entry.workPath]}
                  diffError={diffErrors[entry.workPath]}
                  loading={loadingPaths.has(entry.workPath)}
                  onToggle={() => toggleFile(entry)}
                  onToggleStage={(file) => void toggleStage(file)}
                  sectionRef={(el) => {
                    if (el) sectionRefs.current.set(entry.workPath, el);
                    else sectionRefs.current.delete(entry.workPath);
                  }}
                />
              ))
            )}
          </div>
          {showTree && status.files.length > 0 ? (
            <div className="git-tree-card">
              <div className="git-tree-card-head">文件 · {status.files.length}</div>
              <div className="git-tree-card-list">
                {status.files.map((entry) => (
                  <button
                    key={entry.workPath}
                    type="button"
                    className="git-tree-card-item"
                    title={entry.path}
                    onClick={() => selectFromTree(entry.workPath)}
                  >
                    <span className={`git-tree-card-status git-tree-card-status-${fileStatusLabel(entry)}`}>
                      {statusIcon(entry)}
                    </span>
                    <span className="git-tree-card-name">{pathBaseName(entry.path)}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="git-empty-panel">{error ? "Not a git repository in this folder" : "Loading…"}</div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="git-commit-dialog max-w-md">
          <DialogHeader>
            <DialogTitle>提交更改</DialogTitle>
            <DialogDescription>
              {status?.branch
                ? `分支 ${status.branch}${status.stagedCount > 0 ? ` · 已暂存 ${status.stagedCount} 个文件` : ""}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <div className="git-error" role="alert">
              {error}
            </div>
          ) : null}
          <Textarea
            className="git-message-input"
            placeholder="Commit message… (✨ to generate with pi)"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            disabled={busy}
          />
          <div className="git-actions">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void generate()}
                  disabled={busy || !status || status.files.length === 0}
                >
                  <Sparkles size={13} />
                  Generate
                </Button>
              </TooltipTrigger>
              <TooltipContent>Generate commit message with pi</TooltipContent>
            </Tooltip>
            {status && status.stagedCount > 0 ? (
              <Button variant="outline" size="sm" onClick={() => void unstageAll()} disabled={busy}>
                Unstage all
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => void stageAll()} disabled={busy}>
                Stage all
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => void commit()}
              disabled={busy || !message.trim() || !status || status.stagedCount === 0}
            >
              <GitCommitHorizontal size={13} />
              {phase === "committing" ? "Committing…" : "Commit"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void push()} disabled={busy}>
              <ArrowUp size={13} />
              {phase === "pushing" ? "Pushing…" : "Push"}
            </Button>
          </div>
          <div className="git-status-line">
            {notice ? <span className="git-notice">{notice}</span> : null}
            {phase === "generating" ? <span className="git-busy">Generating commit message with pi…</span> : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
});
