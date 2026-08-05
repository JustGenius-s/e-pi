import {
  ArrowUp,
  GitBranch,
  GitCommitHorizontal,
  LayoutPanelLeft,
  RefreshCw,
  Sparkles,
  Square,
  CheckSquare,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { pathBaseName } from "../lib/format";
import type { GitDiffResult, GitFileEntry, GitStatus } from "../types/contracts";
import { IconButton } from "./IconButton";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface ReviewViewProps {
  cwd: string;
  onBack: () => void;
}

type Phase = "idle" | "generating" | "committing" | "pushing";

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

const FileRow = memo(function FileRow({
  entry,
  selected,
  onSelect,
  onToggleStage,
}: {
  entry: GitFileEntry;
  selected: boolean;
  onSelect: (path: string) => void;
  onToggleStage: (entry: GitFileEntry) => void;
}) {
  const lastSlash = entry.path.lastIndexOf("/");
  const dir = lastSlash >= 0 ? entry.path.slice(0, lastSlash + 1) : "";
  return (
    <div
      role="option"
      aria-selected={selected}
      className={`git-file${selected ? " selected" : ""}`}
      onClick={() => onSelect(entry.workPath)}
    >
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
  );
});

/**
 * Right-hand Git panel: changed files, per-file diff, pi-generated commit
 * messages, commit and push. Memoized so per-session runtime state updates
 * do not disturb its selection or textarea focus.
 */
export const ReviewView = memo(function ReviewView({ cwd, onBack }: ReviewViewProps) {
  const [status, setStatus] = useState<GitStatus>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [diff, setDiff] = useState<GitDiffResult>();
  const [message, setMessage] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const lastAutoRefresh = useRef(0);
  const previousActivity = useRef<string>("idle");

  const refresh = useCallback(async () => {
    if (!cwd) return;
    setError(undefined);
    try {
      const next = await window.ePi.git.status(cwd);
      setStatus(next);
      setSelectedPath((current) => {
        if (current && next.files.some((file) => file.workPath === current)) return current;
        return next.files[0]?.workPath;
      });
    } catch (reason) {
      setStatus(undefined);
      setDiff(undefined);
      setSelectedPath(undefined);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [cwd]);

  // Load on cwd change.
  useEffect(() => {
    setMessage("");
    setNotice(undefined);
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

  // Load the diff for the selected file.
  useEffect(() => {
    if (!cwd || !selectedPath) {
      setDiff(undefined);
      return;
    }
    let cancelled = false;
    void window.ePi.git
      .diff(cwd, selectedPath)
      .then((result) => {
        if (!cancelled) setDiff(result);
      })
      .catch(() => {
        if (!cancelled) setDiff(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, selectedPath]);

  const selectedEntry = useMemo(
    () => status?.files.find((file) => file.workPath === selectedPath),
    [status, selectedPath],
  );

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

  const busy = phase !== "idle";

  return (
    <div className="git-panel-body">
      {status?.branch ? (
        <div className="git-review-meta">
          <GitBranch size={12} />
          <strong>{status.branch}</strong>
          {status.upstream ? (
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
        </div>
      ) : null}

      {error ? (
        <div className="git-error" role="alert">
          {error}
        </div>
      ) : null}

      {status ? (
        <>
          <div className="git-file-list" role="listbox" aria-label="Changed files">
            {status.files.length === 0 ? (
              <div className="git-empty">Working tree clean</div>
            ) : (
              status.files.map((entry) => (
                <FileRow
                  key={entry.workPath}
                  entry={entry}
                  selected={entry.workPath === selectedPath}
                  onSelect={setSelectedPath}
                  onToggleStage={(file) => void toggleStage(file)}
                />
              ))
            )}
          </div>

          <div className="git-diff-wrap">{selectedEntry && diff ? <DiffView result={diff} /> : null}</div>

          <footer className="git-panel-foot">
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
                    disabled={busy || status.files.length === 0}
                  >
                    <Sparkles size={13} />
                    Generate
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Generate commit message with pi</TooltipContent>
              </Tooltip>
              {status.stagedCount > 0 ? (
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
                disabled={busy || !message.trim() || status.stagedCount === 0}
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
          </footer>
        </>
      ) : (
        <div className="git-empty-panel">{error ? "Not a git repository in this folder" : "Loading…"}</div>
      )}
      <div className="tool-view-bar">
        <button type="button" className="tool-view-bar-back" onClick={onBack}>
          <LayoutPanelLeft size={12} />
          内容列表
        </button>
        <IconButton label="Refresh" onClick={() => void refresh()} disabled={busy}>
          <RefreshCw size={13} />
        </IconButton>
      </div>
    </div>
  );
});
