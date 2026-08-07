import {
  Archive,
  BadgePlus,
  ChevronDown,
  ChevronUp,
  FilePlus,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  Moon,
  MoreVertical,
  Package,
  Pencil,
  Pin,
  Plus,
  Settings2,
  Sparkles,
  Star,
  Sun,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { toast } from "sonner";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { emitAttachFiles } from "../../lib/attachmentsBus";
import { compactPath, pathBaseName, relativeTime, sessionTitle } from "../../lib/format";
import { useTheme } from "../../lib/theme";
import type { PiRuntimeState, Project, SessionSummary } from "../../types/contracts";

interface SessionSidebarProps {
  sessions: SessionSummary[];
  /** Multi-folder projects; sessions whose cwd is inside a project's folders join it. */
  projects: Project[];
  activePath?: string;
  /** Live process state per session path; lets the sidebar show background activity. */
  runtimeStates?: Record<string, PiRuntimeState>;
  homeCwd?: string;
  platform?: NodeJS.Platform;
  onSelect: (session: SessionSummary) => void;
  onCreate: (cwd?: string) => void;
  /** Pick a folder, then create a session inside it (new project). */
  onCreateProject: () => void;
  /** Open the multi-repo import dialog. */
  onImportProject: () => void;
  /** Open the import dialog in edit mode for an existing project. */
  onEditProject: (project: Project) => void;
  /** Open the import dialog pre-filled with a folder group (non-multi-repo → multi-repo). */
  onPromoteProject: (cwd: string) => void;
  /** Remove a project group and move all its sessions to the Trash. */
  onRemoveProject: (target: { project?: Project; cwd: string; sessions: SessionSummary[] }) => void;
  onRename: (session: SessionSummary) => void;
  onRemove: (session: SessionSummary) => void;
  onOpenFolder: (cwd: string) => void;
  onCopyText: (text: string) => void;
  onOpenPackages: () => void;
  onOpenSkills: () => void;
  onOpenSettings: () => void;
}

interface ProjectGroup {
  /** The backing project for multi-folder groups. */
  project?: Project;
  /** Stable group key: the project id, or the cwd for implicit single-folder groups. */
  key: string;
  /** The directory sessions/new sessions use (primary repo for multi-folder projects). */
  cwd: string;
  /** Display name for multi-folder projects. */
  name?: string;
  /** Present for multi-folder projects. */
  primaryRepo?: string;
  /** Present for multi-folder projects; ordered, de-duplicated. */
  folders?: string[];
  sessions: SessionSummary[];
}

/** Pinned session paths and pinned project cwds, in pin order. */
interface SidebarPins {
  sessions: string[];
  projects: string[];
}

const PIN_STORAGE_KEY = "sidebar-pins-v1";

function readPins(): SidebarPins {
  try {
    const raw = window.localStorage.getItem(PIN_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SidebarPins>;
      return {
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      };
    }
  } catch {
    // Storage unavailable — start unpinned.
  }
  return { sessions: [], projects: [] };
}

const UNKNOWN_FOLDER = "Unknown folder";

/** Same braille spinner frames as pi-tui's Loader (default 80ms interval). */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Map a 6-dot braille char onto the left two columns of a 3x3 grid:
 * dot 1-3 -> column 0 (rows 0-2), dot 4-6 -> column 1 (rows 0-2)
 * Returns 9 booleans, row-major. The third column stays off, so the spinner
 * and the done/error square share the same 3x3 canvas and dot size.
 */
function braillePattern(character: string): boolean[] {
  const bits = (character.codePointAt(0) ?? 0x2800) - 0x2800;
  const indexOfDot: Record<number, number> = { 1: 0, 2: 3, 3: 6, 4: 1, 5: 4, 6: 7 };
  const pattern = new Array<boolean>(9).fill(false);
  for (let dot = 1; dot <= 6; dot++) {
    if (bits & (1 << (dot - 1))) pattern[indexOfDot[dot]!] = true;
  }
  return pattern;
}

const ALL_DOTS_ON = Array.from({ length: 9 }, () => true);
/** Fixed grid positions so keys are stable and independent of array indices. */
const DOT_POSITIONS = [0, 1, 2, 3, 4, 5, 6, 7, 8];

/** 3x3 dot-matrix canvas; lit dots inherit the parent's color. */
function DotMatrix({ pattern }: { pattern: boolean[] }) {
  return (
    <span className="session-activity-matrix" aria-hidden="true">
      {DOT_POSITIONS.map((position) => (
        <i key={position} data-on={pattern[position] ? "true" : undefined} />
      ))}
    </span>
  );
}

/** Blue braille spinner rendered on the same 3x3 canvas as the squares. */
function ActivitySpinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((current) => (current + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="session-activity working" title="Working…" aria-label="Working…">
      <DotMatrix pattern={braillePattern(SPINNER_FRAMES[frame]!)} />
    </span>
  );
}

interface ActivityIndicatorProps {
  runtime?: PiRuntimeState;
}

/**
 * Per-session status glyph shown before the session title:
 * - working (process running, agent busy): blue braille spinner
 * - done (process running, agent settled): green dot-matrix square
 * - error: red dot-matrix square
 * - every other state: an invisible 12px placeholder
 *
 * The placeholder keeps the row grid at three columns — status, title
 * (1fr, ellipsized), time (auto). Without it a row with no status has only
 * two children, so the title lands in the auto column and the time in the
 * 1fr track, where a long title squeezes it to zero width.
 */
function ActivityIndicator({ runtime }: ActivityIndicatorProps) {
  const working = runtime?.status === "running" && runtime.activity === "busy";
  const done = runtime?.status === "running" && runtime.activity === "idle";
  const failed = runtime?.status === "error";

  if (working) {
    return <ActivitySpinner />;
  }
  if (failed) {
    return (
      <span className="session-activity error" title="Runtime error" aria-label="Runtime error">
        <DotMatrix pattern={ALL_DOTS_ON} />
      </span>
    );
  }
  if (done) {
    return (
      <span className="session-activity done" title="Idle" aria-label="Idle">
        <DotMatrix pattern={ALL_DOTS_ON} />
      </span>
    );
  }
  return <span className="session-activity" aria-hidden="true" />;
}

interface SessionItemContentProps {
  session: SessionSummary;
  runtime?: PiRuntimeState;
  labelClassName: string;
}

function SessionItemContent({ session, runtime, labelClassName }: SessionItemContentProps) {
  return (
    <>
      <ActivityIndicator runtime={runtime} />
      <span className={labelClassName}>{sessionTitle(session)}</span>
      <time dateTime={session.modifiedAt}>{relativeTime(session.modifiedAt)}</time>
    </>
  );
}

interface CollapsedProjectFlyoutProps {
  project: ProjectGroup;
  label: string;
  /** Marks the current session inside the flyout list. */
  activeSessionPath?: string;
  runtimeStates?: Record<string, PiRuntimeState>;
  onSelect: (session: SessionSummary) => void;
  onExpand: () => void;
  /** Create a new session in this project. */
  onCreate: (cwd: string) => void;
}

/** Mid-tone hues for project avatars; dark enough for white letters. */
const PROJECT_AVATAR_COLORS = [
  "oklch(0.58 0.17 25)",
  "oklch(0.57 0.15 120)",
  "oklch(0.56 0.18 240)",
  "oklch(0.55 0.19 300)",
  "oklch(0.6 0.14 85)",
  "oklch(0.55 0.15 180)",
] as const;

/** Deterministic per-project color (stable across renders/sessions). */
function projectAvatarColor(cwd: string): string {
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) hash = (hash * 31 + cwd.charCodeAt(i)) >>> 0;
  return PROJECT_AVATAR_COLORS[hash % PROJECT_AVATAR_COLORS.length];
}

/** Menu items shared by the group-header "+" and the collapsed footer button. */
function NewSessionMenuItems({
  onNewSession,
  onNewProject,
  onImportProject,
}: {
  onNewSession: () => void;
  onNewProject: () => void;
  onImportProject: () => void;
}) {
  return (
    <>
      <DropdownMenuItem onSelect={onNewSession}>
        <FilePlus size={14} />
        <span>New session</span>
        <DropdownMenuShortcut>Home</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={onNewProject}>
        <FolderPlus size={14} />
        <span>New project</span>
        <DropdownMenuShortcut>Choose folder</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onImportProject}>
        <FolderGit2 size={14} />
        <span>Import multi-repo project</span>
      </DropdownMenuItem>
    </>
  );
}

/**
 * Collapsed (icon) mode: one folder button per project. Hovering opens a
 * flyout listing the project's sessions — clicking a session switches to it
 * without expanding the sidebar; clicking the folder itself expands the
 * sidebar and opens that project. The header "+" creates a session in the
 * project directly.
 */
function CollapsedProjectFlyout({
  project,
  label,
  activeSessionPath,
  runtimeStates,
  onSelect,
  onExpand,
  onCreate,
}: CollapsedProjectFlyoutProps) {
  const [open, setOpen] = useState(false);
  const avatarStyle = { "--avatar-color": projectAvatarColor(project.cwd) } as CSSProperties;
  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={120} closeDelay={60}>
      <HoverCardTrigger asChild>
        {/* No tooltip prop: the flyout itself carries the project label. */}
        <SidebarMenuButton className="collapsed-project-button" aria-label={label} onClick={onExpand}>
          <span className="project-avatar" style={avatarStyle} aria-hidden="true">
            {label.charAt(0).toUpperCase()}
          </span>
        </SidebarMenuButton>
      </HoverCardTrigger>
      <HoverCardContent side="right" sideOffset={10} align="start" className="project-flyout">
        <div className="project-flyout-header">
          <span className="project-flyout-title">{label}</span>
          <button
            type="button"
            className="project-flyout-add"
            aria-label={`New session in ${label}`}
            title={`New session in ${label}`}
            onClick={(event) => {
              event.stopPropagation();
              setOpen(false);
              onCreate(project.cwd);
            }}
          >
            <Plus size={12} />
          </button>
        </div>
        <ul className="project-flyout-sessions">
          {project.sessions.map((session) => {
            const isActiveSession = session.path === activeSessionPath;
            return (
              <li key={session.path}>
                <button
                  type="button"
                  className="project-flyout-session"
                  data-active={isActiveSession ? "true" : undefined}
                  aria-current={isActiveSession ? "page" : undefined}
                  onClick={() => {
                    setOpen(false);
                    onSelect(session);
                  }}
                >
                  <SessionItemContent
                    session={session}
                    runtime={runtimeStates?.[session.path]}
                    labelClassName="project-flyout-session-label"
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </HoverCardContent>
    </HoverCard>
  );
}

export function SessionSidebar({
  sessions,
  projects,
  activePath,
  runtimeStates,
  homeCwd,
  platform,
  onSelect,
  onCreate,
  onCreateProject,
  onImportProject,
  onEditProject,
  onPromoteProject,
  onRemoveProject,
  onRename,
  onRemove,
  onOpenFolder,
  onCopyText,
  onOpenPackages,
  onOpenSkills,
  onOpenSettings,
}: SessionSidebarProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  /**
   * Session whose "more actions" dropdown is open. While it is open the
   * row's action bar stays visible even when the pointer leaves the row.
   */
  const [moreMenuPath, setMoreMenuPath] = useState<string | undefined>();
  /** Click-controlled open state of the collapsed pinned-chats flyout. */
  const [pinnedFlyoutOpen, setPinnedFlyoutOpen] = useState(false);
  /**
   * Projects whose session list was expanded past the 5-row preview via
   * "Show more". Collapsing a project resets its expansion, so re-expanding
   * returns to the compact preview.
   */
  const [expandedSessionProjects, setExpandedSessionProjects] = useState<ReadonlySet<string>>(new Set());
  const { state, setOpen } = useSidebar();
  const { theme, toggleTheme } = useTheme();

  /** Reference a session by attaching its JSONL file to the composer. */
  const addToChat = (session: SessionSummary) => {
    emitAttachFiles([session.path]);
    toast.info(`Added to chat: ${sessionTitle(session)}`);
  };

  /**
   * Pinned sessions/projects, persisted in localStorage so the order
   * survives restarts. Pins only affect ordering, nothing else.
   */
  const [pins, setPins] = useState<SidebarPins>(readPins);
  const pinnedSessions = useMemo(() => new Set(pins.sessions), [pins.sessions]);
  const pinnedProjects = useMemo(() => new Set(pins.projects), [pins.projects]);
  const updatePins = (next: SidebarPins) => {
    setPins(next);
    try {
      window.localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage unavailable — pins just won't survive a restart.
    }
  };
  const toggleSessionPin = (path: string) => {
    const nextSessions = pinnedSessions.has(path)
      ? pins.sessions.filter((candidate) => candidate !== path)
      : [...pins.sessions, path];
    updatePins({ ...pins, sessions: nextSessions });
  };
  const toggleProjectPin = (key: string) => {
    const nextProjects = pinnedProjects.has(key)
      ? pins.projects.filter((candidate) => candidate !== key)
      : [...pins.projects, key];
    updatePins({ ...pins, projects: nextProjects });
  };
  /**
   * Stable project order. Sessions arrive sorted by recent activity (so
   * sessions within a project stay recency-ordered), but the project GROUP
   * order is frozen from the first load and never reshuffled when sessions
   * are created — otherwise creating a session would jump its project to the
   * top. Brand-new projects (e.g. a fresh folder) are inserted at the top;
   * existing projects keep their position.
   */
  const groupOrderRef = useRef<string[] | null>(null);

  /** Sessions join a project when their cwd is one of its folders; the rest form implicit cwd groups. */
  const projectByCwd = useMemo(() => {
    const map = new Map<string, Project>();
    for (const project of projects) {
      for (const folder of project.folders) map.set(folder, project);
    }
    return map;
  }, [projects]);

  const projectGroups = useMemo<ProjectGroup[]>(() => {
    const byKey = new Map<string, ProjectGroup>();
    for (const session of sessions) {
      const cwd = session.cwd || UNKNOWN_FOLDER;
      const project = projectByCwd.get(cwd);
      const key = project?.id ?? cwd;
      let group = byKey.get(key);
      if (!group) {
        group = {
          project,
          key,
          cwd: project?.primaryRepo ?? cwd,
          ...(project ? { name: project.name, primaryRepo: project.primaryRepo, folders: project.folders } : {}),
          sessions: [],
        };
        byKey.set(key, group);
      }
      group.sessions.push(session);
    }
    const knownOrder = groupOrderRef.current;
    if (knownOrder === null) {
      // First load: seed the stable order from the initial recency sort.
      groupOrderRef.current = [...byKey.keys()];
      return [...byKey.values()];
    }
    const newProjects = [...byKey.keys()].filter((key) => !knownOrder.includes(key));
    groupOrderRef.current = [...newProjects, ...knownOrder.filter((key) => byKey.has(key))];
    return groupOrderRef.current.map((key) => byKey.get(key)!);
  }, [sessions, projectByCwd]);

  // Pinned projects float above the stable group order. Pinned sessions move
  // out of their project groups entirely and render in a dedicated "Pinned"
  // section at the very top of the session list, in pin order.
  const orderedProjects = useMemo(
    () => [...projectGroups].sort((a, b) => Number(pinnedProjects.has(b.key)) - Number(pinnedProjects.has(a.key))),
    [projectGroups, pinnedProjects],
  );
  const pinnedSessionList = useMemo(
    () =>
      pins.sessions
        .map((path) => sessions.find((session) => session.path === path))
        .filter((session): session is SessionSummary => Boolean(session)),
    [pins.sessions, sessions],
  );
  const pinnedProjectList = useMemo(
    () => orderedProjects.filter((project) => pinnedProjects.has(project.key)),
    [orderedProjects, pinnedProjects],
  );
  const regularProjects = useMemo(
    () => orderedProjects.filter((project) => !pinnedProjects.has(project.key)),
    [orderedProjects, pinnedProjects],
  );

  /**
   * One project row (header + expandable sessions) — used in the Pinned
   * section for pinned workspaces and in the regular list below.
   */
  const renderProjectRow = (project: ProjectGroup) => {
    const pinned = pinnedProjects.has(project.key);
    const visibleSessions = project.sessions.filter((session) => !pinnedSessions.has(session.path));
    // Preview the first 5 sessions; "Show more" reveals the rest and "Show
    // less" collapses back. Collapsing the project also resets the expansion
    // (see toggleProject), so re-expanding returns to the preview.
    const showAll = expandedSessionProjects.has(project.key);
    const limited = visibleSessions.length > 5 && !showAll;
    const shownSessions = limited ? visibleSessions.slice(0, 5) : visibleSessions;
    const header = (
      <div
        className="project-header"
        role="button"
        tabIndex={0}
        onClick={() => toggleProject(project.key)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleProject(project.key);
          }
        }}
      >
        {isCollapsed(project.key) ? (
          <Folder size={12} className="project-icon" aria-hidden="true" />
        ) : (
          <FolderOpen size={12} className="project-icon" aria-hidden="true" />
        )}
        <span className="project-path">{projectLabel(project)}</span>
        <button
          type="button"
          className={`project-pin${pinned ? " active" : ""}`}
          aria-label={pinned ? "Unpin workspace" : "Pin workspace"}
          title={pinned ? "Unpin workspace" : "Pin workspace"}
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
              {pinned ? "Unpin workspace" : "Pin workspace"}
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
            <span className="project-info-name">{projectLabel(project)}</span>
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
            {visibleSessions.length} task{visibleSessions.length === 1 ? "" : "s"}
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
      <div key={project.key} className="project-group">
        {headerWithCard}
        {!isCollapsed(project.key) && (
          <SidebarMenu className="project-sessions">
            {shownSessions.map((session) => renderSessionRow(session))}
          </SidebarMenu>
        )}
        {!isCollapsed(project.key) && limited ? (
          <button
            type="button"
            className="project-show-more"
            onClick={(event) => {
              event.stopPropagation();
              setExpandedSessionProjects((current) => new Set(current).add(project.key));
            }}
          >
            <ChevronDown size={12} />
            <span>Show more</span>
          </button>
        ) : null}
        {!isCollapsed(project.key) && showAll && visibleSessions.length > 5 ? (
          <button
            type="button"
            className="project-show-more"
            onClick={(event) => {
              event.stopPropagation();
              setExpandedSessionProjects((current) => {
                if (!current.has(project.key)) return current;
                const next = new Set(current);
                next.delete(project.key);
                return next;
              });
            }}
          >
            <ChevronUp size={12} />
            <span>Show less</span>
          </button>
        ) : null}
      </div>
    );
  };

  const toggleProject = (cwd: string) => {
    const closing = !collapsed.has(cwd);
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
    if (closing) {
      // Collapsing resets the session-list expansion, so re-expanding the
      // project returns to the 5-row preview instead of the full list.
      setExpandedSessionProjects((current) => {
        if (!current.has(cwd)) return current;
        const next = new Set(current);
        next.delete(cwd);
        return next;
      });
    }
  };

  const isCollapsed = (cwd: string) => collapsed.has(cwd);

  /** Expand the sidebar and reveal one project's sessions (collapsed-mode click). */
  const expandToProject = (cwd: string) => {
    setOpen(true);
    setCollapsed((current) => {
      if (!current.has(cwd)) return current;
      const next = new Set(current);
      next.delete(cwd);
      return next;
    });
  };

  const projectLabel = (project: ProjectGroup) => {
    const cwd = project.cwd;
    if (project.primaryRepo) return project.name ?? pathBaseName(cwd);
    return homeCwd && cwd === homeCwd ? "Home" : pathBaseName(cwd);
  };

  /** One session row (menu button + hover actions). */
  const renderSessionRow = (session: SessionSummary) => {
    const active = session.path === activePath;
    const title = sessionTitle(session);
    const runtime = runtimeStates?.[session.path];
    const pinned = pinnedSessions.has(session.path);
    return (
      <SidebarMenuItem key={session.path} className="session-menu-item">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <SidebarMenuButton
              className="session-menu-button"
              isActive={active}
              tooltip={title}
              title={compactPath(session.cwd || UNKNOWN_FOLDER, 70)}
              onClick={() => onSelect(session)}
            >
              <SessionItemContent session={session} runtime={runtime} labelClassName="session-label" />
            </SidebarMenuButton>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={() => toggleSessionPin(session.path)}>
              {pinned ? "Unpin chat" : "Pin chat"}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onRename(session)}>Rename chat</ContextMenuItem>
            <ContextMenuSeparator />
            {platform === "darwin" && (
              <ContextMenuItem onSelect={() => session.cwd && onOpenFolder(session.cwd)}>
                Open in Finder
              </ContextMenuItem>
            )}
            <ContextMenuItem onSelect={() => session.cwd && onCopyText(session.cwd)}>
              Copy working directory
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onCopyText(session.path)}>Copy session</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => addToChat(session)}>Add to chat</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={() => onRemove(session)}>
              Archive chat
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        {/* Hover actions: replace the time with ⋯ (more) / pin / archive. The
            tooltips must stay delay-free: a delayed open timer can fire after
            the pointer has left the row (the bar turns pointer-events:none
            mid-flight), leaving a tooltip stranded on screen. */}
        <div className="session-row-actions" data-open={moreMenuPath === session.path ? "true" : undefined}>
          <DropdownMenu
            open={moreMenuPath === session.path}
            onOpenChange={(open) => setMoreMenuPath(open ? session.path : undefined)}
          >
            <Tooltip disableHoverableContent>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger className="session-row-action" aria-label="More actions">
                  <MoreVertical size={13} />
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top">More actions</TooltipContent>
            </Tooltip>
            <DropdownMenuContent side="right" align="start" sideOffset={6} className="min-w-[10rem]">
              <DropdownMenuItem onSelect={() => onRename(session)}>Rename chat</DropdownMenuItem>
              {platform === "darwin" && (
                <DropdownMenuItem onSelect={() => session.cwd && onOpenFolder(session.cwd)}>
                  Open in Finder
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => session.cwd && onCopyText(session.cwd)}>
                Copy working directory
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onCopyText(session.path)}>Copy session</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => addToChat(session)}>Add to chat</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip disableHoverableContent>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={`session-row-action${pinned ? " active" : ""}`}
                aria-label={pinned ? "Unpin chat" : "Pin chat"}
                onClick={() => toggleSessionPin(session.path)}
              >
                <Pin size={13} fill={pinned ? "currentColor" : "none"} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{pinned ? "Unpin chat" : "Pin chat"}</TooltipContent>
          </Tooltip>
          <Tooltip disableHoverableContent>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="session-row-action"
                aria-label="Archive chat"
                onClick={() => onRemove(session)}
              >
                <Archive size={13} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Archive chat</TooltipContent>
          </Tooltip>
        </div>
      </SidebarMenuItem>
    );
  };

  return (
    <Sidebar aria-label="Sessions" collapsible="icon" className="session-sidebar">
      <SidebarContent>
        <SidebarGroup className="sidebar-package-group">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton tooltip="Skills" onClick={onOpenSkills}>
                  <Sparkles />
                  <span>Skills</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton tooltip="Packages" onClick={onOpenPackages}>
                  <Package />
                  <span>Packages</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {/* "New session" below Packages in both states; clicking creates a
                  session directly (the full menu with New project / Import
                  multi-repo stays in the Sessions group-header "+"). */}
              <SidebarMenuItem>
                <SidebarMenuButton
                  className="collapsed-new-session"
                  tooltip="New session"
                  aria-label="New session"
                  onClick={() => onCreate(homeCwd)}
                >
                  <BadgePlus />
                  {state !== "collapsed" ? <span>New session</span> : null}
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="sidebar-session-group">
          {state === "collapsed" ? null : (
            <SidebarGroupLabel>
              Sessions
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarGroupAction aria-label="New session or project" title="New session or project">
                    <Plus size={12} />
                  </SidebarGroupAction>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="start" sideOffset={8} className="min-w-[11rem]">
                  <NewSessionMenuItems
                    onNewSession={() => onCreate(homeCwd)}
                    onNewProject={() => onCreateProject()}
                    onImportProject={onImportProject}
                  />
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarGroupLabel>
          )}

          <SidebarGroupContent>
            {pinnedSessionList.length > 0 || pinnedProjectList.length > 0 ? (
              state === "collapsed" ? (
                // Icon-only pinned rows: a pin button per session (tooltip = title)
                // and the project avatar flyout for pinned projects.
                <SidebarMenu className="pinned-sessions-collapsed">
                  {pinnedSessionList.length > 0 ? (
                    <SidebarMenuItem>
                      {/* One aggregated pin button; hovering (or clicking) lists
                          every pinned chat (same flyout pattern as collapsed
                          projects). */}
                      <HoverCard
                        open={pinnedFlyoutOpen}
                        onOpenChange={setPinnedFlyoutOpen}
                        openDelay={120}
                        closeDelay={60}
                      >
                        <HoverCardTrigger asChild>
                          <SidebarMenuButton
                            className="pinned-collapsed-session"
                            aria-label="Pinned chats"
                            onClick={() => setPinnedFlyoutOpen((current) => !current)}
                          >
                            <Pin size={14} fill="currentColor" />
                          </SidebarMenuButton>
                        </HoverCardTrigger>
                        <HoverCardContent side="right" sideOffset={10} align="start" className="project-flyout">
                          <div className="project-flyout-header">
                            <span className="project-flyout-title">
                              Pinned chat{pinnedSessionList.length === 1 ? "" : "s"}
                            </span>
                          </div>
                          <ul className="project-flyout-sessions">
                            {pinnedSessionList.map((session) => {
                              const active = session.path === activePath;
                              return (
                                <li key={session.path}>
                                  <button
                                    type="button"
                                    className={`project-flyout-session${active ? " active" : ""}`}
                                    onClick={() => onSelect(session)}
                                  >
                                    <ActivityIndicator runtime={runtimeStates?.[session.path]} />
                                    <span className="project-flyout-session-label">{sessionTitle(session)}</span>
                                    <time dateTime={session.modifiedAt}>{relativeTime(session.modifiedAt)}</time>
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        </HoverCardContent>
                      </HoverCard>
                    </SidebarMenuItem>
                  ) : null}
                  {pinnedProjectList.map((project) => (
                    <SidebarMenuItem key={project.key}>
                      <CollapsedProjectFlyout
                        project={project}
                        label={projectLabel(project)}
                        activeSessionPath={activePath}
                        runtimeStates={runtimeStates}
                        onSelect={onSelect}
                        onExpand={() => expandToProject(project.cwd)}
                        onCreate={onCreate}
                      />
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              ) : (
                <div className="pinned-sessions">
                  <div className="pinned-sessions-label">Pinned</div>
                  <SidebarMenu className="pinned-sessions-list">
                    {pinnedSessionList.map((session) => renderSessionRow(session))}
                  </SidebarMenu>
                  {pinnedProjectList.map((project) => renderProjectRow(project))}
                </div>
              )
            ) : null}
            {state === "collapsed" ? (
              <SidebarMenu>
                {orderedProjects.map((project) => (
                  <SidebarMenuItem key={project.cwd}>
                    <CollapsedProjectFlyout
                      project={project}
                      label={projectLabel(project)}
                      activeSessionPath={activePath}
                      runtimeStates={runtimeStates}
                      onSelect={onSelect}
                      onExpand={() => expandToProject(project.cwd)}
                      onCreate={onCreate}
                    />
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            ) : sessions.length === 0 ? (
              <div className="sidebar-empty">
                <span>No sessions yet</span>
                <span className="sidebar-empty-hint">New sessions start in Home.</span>
              </div>
            ) : (
              regularProjects.map((project) => renderProjectRow(project))
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="sidebar-settings-row">
              <SidebarMenuButton tooltip="Settings" onClick={onOpenSettings} className="sidebar-settings-button">
                <Settings2 />
                <span>Settings</span>
              </SidebarMenuButton>
              <button
                type="button"
                className="sidebar-theme-toggle"
                title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                onClick={toggleTheme}
              >
                {theme === "dark" ? <Sun /> : <Moon />}
              </button>
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
