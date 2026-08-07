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
  Minimize2,
  Rows2,
  Square,
  Star,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { compactPath, pathBaseName } from "../../lib/format";
import type { GitDiffResult, GitFileEntry, GitNumstat } from "../../types/contracts";
import { DiffView, type DiffStyle } from "./DiffView";

interface ReviewViewProps {
  cwd: string;
  /** Git repos of the current project (multi-repo); shows the repo switcher when >1. */
  repos?: string[];
  /** The project's primary repo; marked with a star in the switcher. */
  primaryRepo?: string;
  onSelectRepo?: (cwd: string) => void;
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
        {dir ? (
          <span className="git-file-dir" title={dir}>
            {dir}
          </span>
        ) : null}
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
            <div className="git-diff-empty">Loading…</div>
          ) : diffError ? (
            <div className="git-diff-error">{diffError}</div>
          ) : diff ? (
            <DiffView patch={diff.diff} style={diffStyle} />
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="git-diff-minimize"
                aria-label="Minimize diff"
                title="Minimize"
                onClick={onToggle}
              >
                <Minimize2 size={12} />
              </button>
            </TooltipTrigger>
            <TooltipContent>Minimize</TooltipContent>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
});

export const ReviewView = memo(function ReviewView({ cwd, repos, primaryRepo, onSelectRepo }: ReviewViewProps) {
  const review = useGitReview(cwd);
  const [showTree, setShowTree] = useState(false);
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
  const commitAndPush = async () => {
    if (await review.commit(true)) setDialogOpen(false);
  };

  return (
    <div className="git-panel-body">
      <div className="git-review-meta">
        {repos && repos.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="git-review-repo" title={cwd}>
                <GitBranch size={12} />
                <span>{pathBaseName(cwd)}</span>
                {cwd === primaryRepo ? (
                  <Star size={10} className="git-review-repo-star" aria-label="Primary repo" />
                ) : null}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="start" sideOffset={6} className="min-w-[12rem]">
              {repos.map((repo) => (
                <DropdownMenuItem key={repo} onSelect={() => onSelectRepo?.(repo)}>
                  <GitBranch size={12} />
                  <span className="git-review-repo-item">
                    <strong>{pathBaseName(repo)}</strong>
                    <em>{compactPath(repo, 48)}</em>
                  </span>
                  {repo === primaryRepo ? (
                    <Star size={10} className="git-review-repo-star" aria-label="Primary repo" />
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <div className="git-review-branches">
          <div className="git-review-branch-line">
            {review.status?.branch ? <GitBranch size={12} className="git-review-branch-icon" /> : null}
            {review.status?.branch ? (
              <Tooltip delayDuration={1200}>
                <TooltipTrigger asChild>
                  <strong>{review.status.branch}</strong>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="start">{review.status.branch}</TooltipContent>
              </Tooltip>
            ) : null}
            {review.status?.branch && review.status.upstream ? (
              <span className="git-review-upstream-arrow" aria-hidden="true">
                →
              </span>
            ) : null}
            {review.status?.branch && review.status.upstream ? (
              <Tooltip delayDuration={1200}>
                <TooltipTrigger asChild>
                  <span className="git-review-upstream">
                    {review.status.upstream}
                    {review.status.ahead > 0 || review.status.behind > 0 ? (
                      <em>
                        {review.status.ahead > 0 ? ` ↑${review.status.ahead}` : ""}
                        {review.status.behind > 0 ? ` ↓${review.status.behind}` : ""}
                      </em>
                    ) : null}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="start">{review.status.upstream}</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </div>
        <div className="git-review-actions">
          <IconButton
            label={allExpanded ? "Collapse all" : "Expand all"}
            onClick={toggleAll}
            disabled={!review.status || review.status.files.length === 0}
          >
            {allExpanded ? <ListChevronsDownUp size={14} /> : <ListChevronsUpDown size={14} />}
          </IconButton>
          <IconButton label={diffStyle === "split" ? "Switch to unified view" : "Switch to split view"} onClick={toggleDiffStyle}>
            {diffStyle === "split" ? <Columns2 size={14} /> : <Rows2 size={14} />}
          </IconButton>
          <IconButton
            label={showTree ? "Hide file tree" : "Show file tree"}
            className={showTree ? "active" : ""}
            onClick={() => setShowTree((current) => !current)}
          >
            <Folders size={14} />
          </IconButton>
          <div className="git-combo">
            <button type="button" className="git-combo-primary" title="Commit" onClick={() => setDialogOpen(true)}>
              <GitCommitHorizontal size={13} />
              Commit
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="git-combo-caret" aria-label="More Git actions">
                  <ChevronDown size={12} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={4}>
                <DropdownMenuItem onSelect={() => setDialogOpen(true)}>
                  <GitCommitHorizontal size={13} />
                  Commit or push
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void review.pull()} disabled={review.busy}>
                  <ArrowDownToLine size={13} />
                  Pull
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
      {review.isRepo && review.error ? (
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
              <div className="git-tree-card-head">Files · {review.status.files.length}</div>
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
        <div className="git-empty-panel">
          {!review.isRepo ? (
            <div className="git-empty-repo">
              <GitBranch size={20} />
              <p>This folder is not a git repository.</p>
              <p className="git-empty-repo-hint">Run git init to start version control.</p>
            </div>
          ) : review.error ? (
            "Unable to load git status"
          ) : (
            "Loading…"
          )}
        </div>
      )}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="git-commit-dialog max-w-md">
          <DialogHeader>
            <DialogTitle>Commit Changes</DialogTitle>
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
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void commit()}
              disabled={review.busy || !review.status || review.status.files.length === 0}
            >
              <GitCommitHorizontal size={13} />
              {review.phase === "committing" ? "Committing…" : "Commit"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void commitAndPush()}
              disabled={review.busy || !review.status || review.status.files.length === 0}
            >
              <ArrowUp size={13} />
              {review.phase === "pushing" ? "Pushing…" : "Commit & Push"}
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
