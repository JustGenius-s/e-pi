import {
  ArrowDownToLine,
  ArrowUp,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Columns2,
  Folders,
  GitBranch,
  GitCommitHorizontal,
  ListChevronsDownUp,
  ListChevronsUpDown,
  Rows2,
  Sparkles,
  Square,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/IconButton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { useGitReview } from "../../hooks/useGitReview";
import { pathBaseName } from "../../lib/format";
import type { GitDiffResult, GitFileEntry, GitNumstat } from "../../types/contracts";
import { DiffView, type DiffStyle } from "./DiffView";

interface ReviewViewProps {
  cwd: string;
}
const REVIEW_DIFF_STYLE_KEY = "e-pi.git.diffStyle";

function fileStatusLabel(entry: GitFileEntry): string {
  if (entry.conflict) return "conflict";
  if (entry.untracked) return "untracked";
  if (entry.staged) return "staged";
  return "modified";
}
function statusLetter(entry: GitFileEntry): string {
  if (entry.conflict) return "!";
  if (entry.untracked) return "A";
  const index = entry.status[0];
  const work = entry.status[1];
  if (index === "A") return "A";
  if (index === "D" || work === "D") return "D";
  return "M";
}
function statusTone(entry: GitFileEntry): "add" | "del" | "mod" | "conflict" {
  if (entry.conflict) return "conflict";
  const letter = statusLetter(entry);
  return letter === "A" ? "add" : letter === "D" ? "del" : "mod";
}
function statusIcon(entry: GitFileEntry): string {
  if (entry.conflict) return "!";
  if (entry.untracked) return "?";
  if (entry.staged && entry.status[1] === " ") return "A";
  if (entry.staged) return "M";
  return entry.status[1] === "D" ? "D" : "M";
}

interface FileSectionProps {
  entry: GitFileEntry;
  expanded: boolean;
  diff?: GitDiffResult;
  diffError?: string;
  loading: boolean;
  diffStyle: DiffStyle;
  numstat?: GitNumstat;
  onToggle: () => void;
  onToggleStage: (entry: GitFileEntry) => void;
  sectionRef: (el: HTMLDivElement | null) => void;
}

const FileSection = memo(function FileSection({
  entry,
  expanded,
  diff,
  diffError,
  loading,
  diffStyle,
  numstat,
  onToggle,
  onToggleStage,
  sectionRef,
}: FileSectionProps) {
  const lastSlash = entry.path.lastIndexOf("/");
  const dir = lastSlash >= 0 ? entry.path.slice(0, lastSlash + 1) : "";
  const stats = numstat !== undefined && (numstat.additions > 0 || numstat.deletions > 0) ? numstat : undefined;
  return (
    <div className="git-file-section" ref={sectionRef}>
      <div
        role="option"
        aria-selected={expanded}
        aria-expanded={expanded}
        className={`git-file${expanded ? " expanded" : ""}`}
        onClick={onToggle}
      >
        <span className={`git-file-status git-file-status-${statusTone(entry)}`}>{statusLetter(entry)}</span>
        <span className="git-file-name" title={entry.path}>
          {pathBaseName(entry.path)}
        </span>
        {dir ? <span className="git-file-dir">{dir}</span> : null}
        {stats ? (
          <span className="git-file-stats">
            <em className="git-file-stats-add">+{stats.additions}</em>
            <em className="git-file-stats-del">−{stats.deletions}</em>
          </span>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className={`git-file-stage git-file-stage-${fileStatusLabel(entry)} git-file-action`}
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
        <span className="git-file-chevron git-file-action">
          <ChevronRight size={11} className={expanded ? "rotated" : ""} />
        </span>
      </div>
      {expanded ? (
        <div className="git-diff-wrap">
          {loading ? (
            <div className="git-diff-empty">加载中…</div>
          ) : diffError ? (
            <div className="git-diff-error">{diffError}</div>
          ) : diff ? (
            <DiffView patch={diff.diff} style={diffStyle} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

export const ReviewView = memo(function ReviewView({ cwd }: ReviewViewProps) {
  const review = useGitReview(cwd);
  const [showTree, setShowTree] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [diffStyle, setDiffStyle] = useState<DiffStyle>(() => {
    try {
      return window.localStorage.getItem(REVIEW_DIFF_STYLE_KEY) === "unified" ? "unified" : "split";
    } catch {
      return "split";
    }
  });
  const sectionRefs = useRef(new Map<string, HTMLDivElement>());
  const pendingScroll = useRef<string | undefined>(undefined);
  const allExpanded =
    Boolean(review.status?.files.length) && review.status!.files.every((file) => review.expanded.has(file.workPath));

  const toggleAll = () => {
    if (!review.status) return;
    const next = new Set<string>();
    if (!allExpanded)
      for (const file of review.status.files) {
        next.add(file.workPath);
        review.loadDiff(file.workPath);
      }
    review.setExpanded(next);
  };
  const selectFromTree = (path: string) => {
    if (!review.expanded.has(path)) {
      const entry = review.status?.files.find((file) => file.workPath === path);
      if (entry) review.toggleFile(entry);
      pendingScroll.current = path;
    } else sectionRefs.current.get(path)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  useEffect(() => {
    const path = pendingScroll.current;
    if (!path) return;
    pendingScroll.current = undefined;
    sectionRefs.current.get(path)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [review.expanded]);
  const toggleDiffStyle = () =>
    setDiffStyle((current) => {
      const next = current === "split" ? "unified" : "split";
      try {
        window.localStorage.setItem(REVIEW_DIFF_STYLE_KEY, next);
      } catch {
        /* memory state remains usable */
      }
      return next;
    });
  const commit = async () => {
    if (await review.commit()) setDialogOpen(false);
  };

  return (
    <div className="git-panel-body">
      <div className="git-review-meta">
        {review.status?.branch ? <GitBranch size={12} /> : null}
        {review.status?.branch ? <strong>{review.status.branch}</strong> : null}
        {review.status?.branch && review.status.upstream ? (
          <span>
            {review.status.upstream}
            {review.status.ahead > 0 || review.status.behind > 0 ? (
              <em>
                {review.status.ahead > 0 ? ` ↑${review.status.ahead}` : ""}
                {review.status.behind > 0 ? ` ↓${review.status.behind}` : ""}
              </em>
            ) : null}
          </span>
        ) : null}
        <div className="git-review-actions">
          <IconButton
            label={allExpanded ? "全部折叠" : "全部展开"}
            onClick={toggleAll}
            disabled={!review.status || review.status.files.length === 0}
          >
            {allExpanded ? <ListChevronsDownUp size={14} /> : <ListChevronsUpDown size={14} />}
          </IconButton>
          <IconButton label={diffStyle === "split" ? "切换为单栏显示" : "切换为分栏显示"} onClick={toggleDiffStyle}>
            {diffStyle === "split" ? <Columns2 size={14} /> : <Rows2 size={14} />}
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
                <DropdownMenuItem onSelect={() => void review.pull()} disabled={review.busy}>
                  <ArrowDownToLine size={13} />
                  拉取代码
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
      {review.notice || review.busy ? (
        <div className="git-status-strip">
          {review.notice ? <span className="git-notice">{review.notice}</span> : null}
          {review.phase === "generating" ? <span className="git-busy">Generating commit message with pi…</span> : null}
          {review.phase === "pulling" ? <span className="git-busy">Pulling…</span> : null}
        </div>
      ) : null}
      {review.error ? (
        <div className="git-error" role="alert">
          {review.error}
        </div>
      ) : null}
      {review.status ? (
        <div className="git-main">
          <div className="git-files" role="listbox" aria-label="Changed files">
            {review.status.files.length === 0 ? (
              <div className="git-empty">Working tree clean</div>
            ) : (
              review.status.files.map((entry) => (
                <FileSection
                  key={entry.workPath}
                  entry={entry}
                  expanded={review.expanded.has(entry.workPath)}
                  diff={review.diffs[entry.workPath]}
                  diffError={review.diffErrors[entry.workPath]}
                  loading={review.loadingPaths.has(entry.workPath)}
                  diffStyle={diffStyle}
                  numstat={review.status?.numstat?.[entry.workPath]}
                  onToggle={() => review.toggleFile(entry)}
                  onToggleStage={(file) => void review.stage(file)}
                  sectionRef={(element) => {
                    if (element) sectionRefs.current.set(entry.workPath, element);
                    else sectionRefs.current.delete(entry.workPath);
                  }}
                />
              ))
            )}
          </div>
          {showTree && review.status.files.length > 0 ? (
            <div className="git-tree-card">
              <div className="git-tree-card-head">文件 · {review.status.files.length}</div>
              <div className="git-tree-card-list">
                {review.status.files.map((entry) => (
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
        <div className="git-empty-panel">{review.error ? "Not a git repository in this folder" : "Loading…"}</div>
      )}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="git-commit-dialog max-w-md">
          <DialogHeader>
            <DialogTitle>提交更改</DialogTitle>
            <DialogDescription>
              {review.status?.branch
                ? `分支 ${review.status.branch}${review.status.stagedCount > 0 ? ` · 已暂存 ${review.status.stagedCount} 个文件` : ""}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {review.error ? (
            <div className="git-error" role="alert">
              {review.error}
            </div>
          ) : null}
          <Textarea
            className="git-message-input"
            placeholder="Commit message… (✨ to generate with pi)"
            value={review.message}
            onChange={(event) => review.setMessage(event.target.value)}
            disabled={review.busy}
          />
          <div className="git-actions">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void review.generate()}
                  disabled={review.busy || !review.status || review.status.files.length === 0}
                >
                  <Sparkles size={13} />
                  Generate
                </Button>
              </TooltipTrigger>
              <TooltipContent>Generate commit message with pi</TooltipContent>
            </Tooltip>
            {review.status && review.status.stagedCount > 0 ? (
              <Button variant="outline" size="sm" onClick={() => void review.unstageAll()} disabled={review.busy}>
                Unstage all
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => void review.stageAll()} disabled={review.busy}>
                Stage all
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => void commit()}
              disabled={review.busy || !review.message.trim() || !review.status || review.status.stagedCount === 0}
            >
              <GitCommitHorizontal size={13} />
              {review.phase === "committing" ? "Committing…" : "Commit"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void review.push()} disabled={review.busy}>
              <ArrowUp size={13} />
              {review.phase === "pushing" ? "Pushing…" : "Push"}
            </Button>
          </div>
          <div className="git-status-line">
            {review.notice ? <span className="git-notice">{review.notice}</span> : null}
            {review.phase === "generating" ? (
              <span className="git-busy">Generating commit message with pi…</span>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
});
