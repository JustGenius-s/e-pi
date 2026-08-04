import { Folder, FolderOpen, Package, Plus, Settings2, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { PiRuntimeState, SessionSummary } from "../types/contracts";
import { compactPath, pathBaseName, relativeTime, sessionTitle } from "../lib/format";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/context-menu";
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
} from "./ui/sidebar";

interface SessionSidebarProps {
  sessions: SessionSummary[];
  activePath?: string;
  /** Live process state per session path; lets the sidebar show background activity. */
  runtimeStates?: Record<string, PiRuntimeState>;
  homeCwd?: string;
  platform?: NodeJS.Platform;
  onSelect: (session: SessionSummary) => void;
  onCreate: (cwd?: string) => void;
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
/** Full braille block: the "dot-matrix square" used for done/error states. */
const DOT_MATRIX_SQUARE = "⣿";

interface ActivityIndicatorProps {
  runtime?: PiRuntimeState;
}

/**
 * Per-session status glyph shown before the session title:
 * - working (process running, agent busy): blue braille spinner
 * - done (process running, agent settled): green dot-matrix square
 * - error: red dot-matrix square
 * - every other state: invisible placeholder (keeps titles aligned)
 */
function ActivityIndicator({ runtime }: ActivityIndicatorProps) {
  const working = runtime?.status === "running" && runtime.activity === "busy";
  const done = runtime?.status === "running" && runtime.activity === "idle";
  const failed = runtime?.status === "error";
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!working) return;
    const id = setInterval(() => setFrame((current) => (current + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, [working]);

  if (working) {
    return (
      <span className="session-activity working" title="Working…" aria-label="Working…">
        {SPINNER_FRAMES[frame]}
      </span>
    );
  }
  if (failed) {
    return (
      <span className="session-activity error" title="Runtime error" aria-label="Runtime error">
        {DOT_MATRIX_SQUARE}
      </span>
    );
  }
  if (done) {
    return (
      <span className="session-activity done" title="Idle" aria-label="Idle">
        {DOT_MATRIX_SQUARE}
      </span>
    );
  }
  return <span className="session-activity placeholder" aria-hidden="true" />;
}

export function SessionSidebar({
  sessions,
  activePath,
  runtimeStates,
  homeCwd,
  platform,
  onSelect,
  onCreate,
  onRename,
  onRemove,
  onOpenFolder,
  onCopyText,
  onOpenPackages,
  onOpenSkills,
  onOpenSettings,
}: SessionSidebarProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  // Sessions arrive sorted by most recent activity, so grouping by cwd
  // preserves both project recency order and per-project recency order.
  const projects = useMemo<ProjectGroup[]>(() => {
    const byCwd = new Map<string, SessionSummary[]>();
    for (const session of sessions) {
      const cwd = session.cwd || UNKNOWN_FOLDER;
      const list = byCwd.get(cwd);
      if (list) list.push(session);
      else byCwd.set(cwd, [session]);
    }
    return [...byCwd.entries()].map(([cwd, projectSessions]) => ({
      cwd,
      sessions: projectSessions,
    }));
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

  const projectLabel = (cwd: string) => (homeCwd && cwd === homeCwd ? "Home" : pathBaseName(cwd));

  return (
    <Sidebar aria-label="Sessions" collapsible="icon">
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
          <SidebarGroupLabel>
            Sessions
            <SidebarGroupAction
              onClick={() => onCreate(homeCwd)}
              aria-label="New session in home directory"
              title="New session in Home"
            >
              <Plus size={12} />
            </SidebarGroupAction>
          </SidebarGroupLabel>

          <SidebarGroupContent>
            {sessions.length === 0 ? (
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
                                  <ActivityIndicator runtime={runtime} />
                                  <span className="session-label">{title}</span>
                                  <time dateTime={session.modifiedAt}>
                                    {relativeTime(session.modifiedAt)}
                                  </time>
                                </SidebarMenuButton>
                              </ContextMenuTrigger>
                              <ContextMenuContent>
                                <ContextMenuItem onSelect={() => onRename(session)}>
                                  Rename chat
                                </ContextMenuItem>
                                <ContextMenuSeparator />
                                {platform === "darwin" && (
                                  <ContextMenuItem
                                    onSelect={() => session.cwd && onOpenFolder(session.cwd)}
                                  >
                                    Open in Finder
                                  </ContextMenuItem>
                                )}
                                <ContextMenuItem
                                  onSelect={() => session.cwd && onCopyText(session.cwd)}
                                >
                                  Copy working directory
                                </ContextMenuItem>
                                <ContextMenuItem onSelect={() => onCopyText(session.path)}>
                                  Copy session
                                </ContextMenuItem>
                                <ContextMenuSeparator />
                                <ContextMenuItem
                                  variant="destructive"
                                  onSelect={() => onRemove(session)}
                                >
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
            <SidebarMenuButton tooltip="Settings" onClick={onOpenSettings}>
              <Settings2 />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
