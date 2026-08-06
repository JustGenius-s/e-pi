import {
  BadgePlus,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Moon,
  Package,
  Plus,
  Settings2,
  Sparkles,
  Sun,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

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

import { compactPath, pathBaseName, relativeTime, sessionTitle } from "../../lib/format";
import { useTheme } from "../../lib/theme";
import type { PiRuntimeState, SessionSummary } from "../../types/contracts";

interface SessionSidebarProps {
  sessions: SessionSummary[];
  activePath?: string;
  /** Live process state per session path; lets the sidebar show background activity. */
  runtimeStates?: Record<string, PiRuntimeState>;
  homeCwd?: string;
  platform?: NodeJS.Platform;
  onSelect: (session: SessionSummary) => void;
  onCreate: (cwd?: string) => void;
  /** Pick a folder, then create a session inside it (new project). */
  onCreateProject: () => void;
  onRename: (session: SessionSummary) => void;
  onRemove: (session: SessionSummary) => void;
  onOpenFolder: (cwd: string) => void;
  onCopyText: (text: string) => void;
  onOpenPackages: () => void;
  onOpenSkills: () => void;
  onOpenSettings: () => void;
}

interface ProjectGroup {
  cwd: string;
  sessions: SessionSummary[];
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
 * - every other state: nothing rendered
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
  return null;
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
function NewSessionMenuItems({ onNewSession, onNewProject }: { onNewSession: () => void; onNewProject: () => void }) {
  return (
    <>
      <DropdownMenuItem onSelect={onNewSession}>
        <FilePlus size={14} />
        <span>新会话</span>
        <DropdownMenuShortcut>Home</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={onNewProject}>
        <FolderPlus size={14} />
        <span>新项目</span>
        <DropdownMenuShortcut>选择文件夹</DropdownMenuShortcut>
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
  activePath,
  runtimeStates,
  homeCwd,
  platform,
  onSelect,
  onCreate,
  onCreateProject,
  onRename,
  onRemove,
  onOpenFolder,
  onCopyText,
  onOpenPackages,
  onOpenSkills,
  onOpenSettings,
}: SessionSidebarProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const { state, setOpen } = useSidebar();
  const { theme, toggleTheme } = useTheme();
  /**
   * Stable project order. Sessions arrive sorted by recent activity (so
   * sessions within a project stay recency-ordered), but the project GROUP
   * order is frozen from the first load and never reshuffled when sessions
   * are created — otherwise creating a session would jump its project to the
   * top. Brand-new projects (e.g. a fresh folder) are inserted at the top;
   * existing projects keep their position.
   */
  const groupOrderRef = useRef<string[] | null>(null);

  const projects = useMemo<ProjectGroup[]>(() => {
    const byCwd = new Map<string, SessionSummary[]>();
    for (const session of sessions) {
      const cwd = session.cwd || UNKNOWN_FOLDER;
      const list = byCwd.get(cwd);
      if (list) list.push(session);
      else byCwd.set(cwd, [session]);
    }
    const knownOrder = groupOrderRef.current;
    if (knownOrder === null) {
      // First load: seed the stable order from the initial recency sort.
      groupOrderRef.current = [...byCwd.keys()];
      return [...byCwd.entries()].map(([cwd, projectSessions]) => ({ cwd, sessions: projectSessions }));
    }
    const newProjects = [...byCwd.keys()].filter((cwd) => !knownOrder.includes(cwd));
    groupOrderRef.current = [...newProjects, ...knownOrder.filter((cwd) => byCwd.has(cwd))];
    return groupOrderRef.current.map((cwd) => ({ cwd, sessions: byCwd.get(cwd)! }));
  }, [sessions]);

  const toggleProject = (cwd: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
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

  const projectLabel = (cwd: string) => (homeCwd && cwd === homeCwd ? "Home" : pathBaseName(cwd));

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
                  <NewSessionMenuItems onNewSession={() => onCreate(homeCwd)} onNewProject={() => onCreateProject()} />
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarGroupLabel>
          )}

          <SidebarGroupContent>
            {state === "collapsed" ? (
              <SidebarMenu>
                <SidebarMenuItem>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <SidebarMenuButton
                        className="collapsed-new-session"
                        tooltip="New session or project"
                        aria-label="New session or project"
                      >
                        <BadgePlus />
                      </SidebarMenuButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="right" align="start" sideOffset={8} className="min-w-[11rem]">
                      <NewSessionMenuItems
                        onNewSession={() => onCreate(homeCwd)}
                        onNewProject={() => onCreateProject()}
                      />
                    </DropdownMenuContent>
                  </DropdownMenu>
                </SidebarMenuItem>
                {projects.map((project) => (
                  <SidebarMenuItem key={project.cwd}>
                    <CollapsedProjectFlyout
                      project={project}
                      label={projectLabel(project.cwd)}
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
              projects.map((project) => (
                <div key={project.cwd} className="project-group">
                  <div
                    className="project-header"
                    role="button"
                    tabIndex={0}
                    title={project.cwd}
                    onClick={() => toggleProject(project.cwd)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        toggleProject(project.cwd);
                      }
                    }}
                  >
                    {isCollapsed(project.cwd) ? (
                      <Folder size={12} className="project-icon" aria-hidden="true" />
                    ) : (
                      <FolderOpen size={12} className="project-icon" aria-hidden="true" />
                    )}
                    <span className="project-path">{projectLabel(project.cwd)}</span>
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
                  {!isCollapsed(project.cwd) && (
                    <SidebarMenu className="project-sessions">
                      {project.sessions.map((session) => {
                        const active = session.path === activePath;
                        const title = sessionTitle(session);
                        const runtime = runtimeStates?.[session.path];
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
                                  <SessionItemContent
                                    session={session}
                                    runtime={runtime}
                                    labelClassName="session-label"
                                  />
                                </SidebarMenuButton>
                              </ContextMenuTrigger>
                              <ContextMenuContent>
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
                                <ContextMenuItem onSelect={() => onCopyText(session.path)}>
                                  Copy session
                                </ContextMenuItem>
                                <ContextMenuSeparator />
                                <ContextMenuItem variant="destructive" onSelect={() => onRemove(session)}>
                                  Archive chat
                                </ContextMenuItem>
                              </ContextMenuContent>
                            </ContextMenu>
                          </SidebarMenuItem>
                        );
                      })}
                    </SidebarMenu>
                  )}
                </div>
              ))
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
                title={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"}
                aria-label={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"}
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
