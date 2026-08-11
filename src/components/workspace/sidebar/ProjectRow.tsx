import { Archive, ChevronDown, ChevronUp, Folder, FolderGit2, FolderOpen, Pencil, Pin, Plus, Star } from "lucide-react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { SidebarMenu } from "@/components/ui/sidebar";

import { compactPath } from "../../../lib/format";
import type { Project } from "../../../types/contracts";
import type { ProjectGroup } from "./shared";

interface ProjectRowProps {
  project: ProjectGroup;
  label: string;
  pinned: boolean;
  /** Number of sessions shown in the header hover card (excludes pinned-out ones). */
  sessionCount: number;
  platform?: NodeJS.Platform;
  /** Toggle the project's collapsed state; also resets its session expansion. */
  onToggle: () => void;
  collapsed: boolean;
  /** Session rows to render when expanded (already limited to the preview). */
  children: React.ReactNode;
  /** Show-more/less expander rendered below the session list. */
  footer?: React.ReactNode;
  onCreate: (cwd: string) => void;
  toggleProjectPin: (key: string) => void;
  onOpenFolder: (cwd: string) => void;
  onCopyText: (text: string) => void;
  onEditProject: (project: Project) => void;
  onPromoteProject: (cwd: string) => void;
  onRemoveProject: (target: { project?: Project; cwd: string; sessions: ProjectGroup["sessions"] }) => void;
}

/**
 * One project row (header + expandable sessions) — used in the Pinned
 * section for pinned workspaces and in the regular list below. The header
 * carries a context menu and a hover card with the project details.
 */
export function ProjectRow({
  project,
  label,
  pinned,
  sessionCount,
  platform,
  onToggle,
  collapsed,
  children,
  footer,
  onCreate,
  toggleProjectPin,
  onOpenFolder,
  onCopyText,
  onEditProject,
  onPromoteProject,
  onRemoveProject,
}: ProjectRowProps) {
  const header = (
    <div
      className="project-header"
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onToggle();
        }
      }}
    >
      {collapsed ? (
        <Folder size={12} className="project-icon" aria-hidden="true" />
      ) : (
        <FolderOpen size={12} className="project-icon" aria-hidden="true" />
      )}
      <span className="project-path">{label}</span>
      <button
        type="button"
        className={`project-pin${pinned ? " active" : ""}`}
        aria-label={pinned ? "Unpin project" : "Pin project"}
        title={pinned ? "Unpin project" : "Pin project"}
        onClick={(event) => {
          event.stopPropagation();
          toggleProjectPin(project.key);
        }}
      >
        <Pin size={11} fill={pinned ? "currentColor" : "none"} />
      </button>
      <button
        type="button"
        className="project-add"
        aria-label={`New session in ${project.cwd}`}
        title={`New session in ${project.cwd}`}
        onClick={(event) => {
          event.stopPropagation();
          onCreate(project.cwd);
        }}
      >
        <Plus size={12} />
      </button>
    </div>
  );
  // Hover the project row ~500ms to preview the project: name, task count,
  // primary repo and every source folder, plus the edit entry. The triggers
  // nest asChild-style: both the context menu and the hover card attach to
  // the same header element.
  const headerWithCard = (
    <HoverCard openDelay={500} closeDelay={100}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <HoverCardTrigger asChild>{header}</HoverCardTrigger>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => toggleProjectPin(project.key)}>
            {pinned ? "Unpin project" : "Pin project"}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onCreate(project.cwd)}>
            New session {project.primaryRepo ? "in primary repo" : "in this folder"}
          </ContextMenuItem>
          <ContextMenuSeparator />
          {platform === "darwin" && (
            <ContextMenuItem onSelect={() => onOpenFolder(project.cwd)}>Open in Finder</ContextMenuItem>
          )}
          <ContextMenuItem onSelect={() => onCopyText(project.cwd)}>Copy working directory</ContextMenuItem>
          {project.primaryRepo ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => onEditProject(project.project!)}>Edit project</ContextMenuItem>
            </>
          ) : null}
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => onRemoveProject(project)}>
            Remove project
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <HoverCardContent side="right" sideOffset={8} align="start" className="project-info-card">
        <div className="project-info-row">
          <FolderGit2 size={15} className="project-info-icon" aria-hidden="true" />
          <span className="project-info-name">{label}</span>
          <button
            type="button"
            className="project-info-rename"
            title={project.primaryRepo ? "Rename project" : "Convert to multi-repo project"}
            aria-label={project.primaryRepo ? "Rename project" : "Convert to multi-repo project"}
            onClick={(event) => {
              event.stopPropagation();
              // Multi-folder projects open the edit dialog; implicit folder
              // groups (no persisted project) pre-fill the import dialog so
              // they can be promoted to a multi-repo project.
              if (project.project) onEditProject(project.project);
              else onPromoteProject(project.cwd);
            }}
          >
            <Pencil size={11} />
          </button>
          <button
            type="button"
            className="project-info-remove"
            title="Remove project"
            aria-label="Remove project"
            onClick={(event) => {
              event.stopPropagation();
              onRemoveProject(project);
            }}
          >
            <Archive size={11} />
          </button>
          {project.primaryRepo ? <Star size={12} className="project-info-primary" aria-hidden="true" /> : null}
        </div>
        <div className="project-info-meta">
          {sessionCount} task{sessionCount === 1 ? "" : "s"}
        </div>
        <div className="project-info-sep" />
        {project.primaryRepo ? (
          <>
            <div className="project-info-folder" title={project.primaryRepo}>
              <Star size={11} className="project-info-folder-icon" aria-hidden="true" />
              <span className="project-info-folder-path">{compactPath(project.primaryRepo, 60)}</span>
              <span className="project-info-folder-tag">primary</span>
            </div>
            {project.folders?.map((folder) => (
              <div className="project-info-folder" key={folder} title={folder}>
                <Folder size={11} className="project-info-folder-icon" aria-hidden="true" />
                <span className="project-info-folder-path">{compactPath(folder, 60)}</span>
              </div>
            ))}
          </>
        ) : (
          // Implicit single-folder project: show its directory.
          <div className="project-info-folder" title={project.cwd}>
            <Folder size={11} className="project-info-folder-icon" aria-hidden="true" />
            <span className="project-info-folder-path">{compactPath(project.cwd, 60)}</span>
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  );

  return (
    <div className="project-group">
      {headerWithCard}
      {!collapsed && <SidebarMenu className="project-sessions">{children}</SidebarMenu>}
      {!collapsed && footer}
    </div>
  );
}

interface ShowMoreProps {
  projectKey: string;
  /** Total visible (non-pinned-out) sessions. */
  total: number;
  showAll: boolean;
  onShowAll: (key: string) => void;
  onShowLess: (key: string) => void;
}

/** "Show more/less" expander below the 5-session preview of a project. */
export function ShowMore({ projectKey, total, showAll, onShowAll, onShowLess }: ShowMoreProps) {
  if (!showAll && total <= 5) return null;
  if (!showAll) {
    return (
      <button
        type="button"
        className="project-show-more"
        onClick={(event) => {
          event.stopPropagation();
          onShowAll(projectKey);
        }}
      >
        <ChevronDown size={12} />
        <span>Show more</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      className="project-show-more"
      onClick={(event) => {
        event.stopPropagation();
        onShowLess(projectKey);
      }}
    >
      <ChevronUp size={12} />
      <span>Show less</span>
    </button>
  );
}
