import { BadgePlus, ChevronDown, Moon, Package, Pin, Plus, Settings2, Sparkles, Sun } from "lucide-react";
import { memo, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

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

import { useUnseenRunCompletions } from "../../hooks/useUnseenRunCompletions";
import { emitAttachFiles } from "../../lib/attachmentsBus";
import { pathBaseName, sessionTitle } from "../../lib/format";
import { useTheme } from "../../lib/theme";
import type { PiRuntimeState, Project, SessionSummary } from "../../types/contracts";
import { ProjectFlyout } from "./sidebar/ProjectFlyout";
import { ProjectRow, ShowMore } from "./sidebar/ProjectRow";
import { SessionRow } from "./sidebar/SessionRow";
import {
  PINS_KEY,
  readPins,
  UNKNOWN_FOLDER,
  type Pins,
  type ProjectGroup,
  type SessionRowCallbacks,
} from "./sidebar/shared";

/** Drag-resized max-height of the expanded PINNED section (px). */
const PINNED_HEIGHT_KEY = "sidebar-pinned-height-v1";
/** Smallest the PINNED section can be dragged to (label + one row). */
const PINNED_SECTION_MIN = 32;
/** Space (px) the PROJECTS group keeps when the pinned section is resized. */
const PROJECTS_MIN_SPACE = 110;

function readPinnedSectionHeight(): number | undefined {
  try {
    const saved = window.localStorage.getItem(PINNED_HEIGHT_KEY);
    if (saved !== null) {
      const parsed = Number(saved);
      if (Number.isFinite(parsed) && parsed >= PINNED_SECTION_MIN) return parsed;
    }
  } catch {
    // Storage unavailable — use the natural height.
  }
  return undefined;
}

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
  /** Restart the session's pi process (e.g. after installing packages). */
  onReload: (session: SessionSummary) => void;
  onOpenFolder: (cwd: string) => void;
  onCopyText: (text: string) => void;
  onOpenPackages: () => void;
  onOpenSkills: () => void;
  onOpenSettings: () => void;
}

export const SessionSidebar = memo(function SessionSidebar({
  sessions,
  projects,
  activePath,
  runtimeStates,
  homeCwd,
  platform,
  onSelect,
  onCreate,
  onImportProject,
  onEditProject,
  onPromoteProject,
  onRemoveProject,
  onRename,
  onRemove,
  onReload,
  onOpenFolder,
  onCopyText,
  onOpenPackages,
  onOpenSkills,
  onOpenSettings,
}: SessionSidebarProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  /** Click-controlled open state of the collapsed pinned-chats flyout. */
  const [pinnedFlyoutOpen, setPinnedFlyoutOpen] = useState(false);
  /** PINNED section collapsed by the user (chevron on the section label). */
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
  /** RECENT (default-folder sessions) collapsed by the user. */
  const [recentCollapsed, setRecentCollapsed] = useState(false);
  /**
   * Projects whose session list was expanded past the 5-row preview via
   * "Show more". Collapsing a project resets its expansion, so re-expanding
   * returns to the compact preview.
   */
  const [expandedSessionProjects, setExpandedSessionProjects] = useState<ReadonlySet<string>>(new Set());
  const { state, setOpen } = useSidebar();
  /** Sessions whose background run finished while not focused; blue nav dot. */
  const unseenRuns = useUnseenRunCompletions(runtimeStates ?? {}, activePath);
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
  const [pins, setPins] = useState<Pins>(readPins);
  const pinnedSessions = useMemo(() => new Set(pins.sessions), [pins.sessions]);
  const pinnedProjects = useMemo(() => new Set(pins.projects), [pins.projects]);
  const updatePins = (next: Pins) => {
    setPins(next);
    try {
      window.localStorage.setItem(PINS_KEY, JSON.stringify(next));
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
      // Default-folder sessions are listed under "Recent" instead of being
      // grouped as their own project.
      if (homeCwd && session.cwd === homeCwd) continue;
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
  }, [sessions, projectByCwd, homeCwd]);

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

  /** Default-folder sessions, listed flat under "Recent" (recency order). */
  const recentSessions = useMemo(
    () => (homeCwd ? sessions.filter((session) => session.cwd === homeCwd) : []),
    [sessions, homeCwd],
  );
  /** Collapsed-mode flyout entry for the default folder ("Home"). */
  const homeProject: ProjectGroup | undefined =
    homeCwd && recentSessions.length > 0 ? { key: homeCwd, cwd: homeCwd, sessions: recentSessions } : undefined;

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

  /**
   * Drag-resized max-height (px) of the expanded PINNED section; undefined
   * means the section grows naturally and the sidebar scrolls as a whole.
   */
  const [pinnedMaxHeight, setPinnedMaxHeight] = useState<number | undefined>(readPinnedSectionHeight);
  const pinnedSectionRef = useRef<HTMLDivElement>(null);

  const persistPinnedHeight = (height: number) => {
    setPinnedMaxHeight(height);
    try {
      window.localStorage.setItem(PINNED_HEIGHT_KEY, String(height));
    } catch {
      // Storage unavailable — the resize just won't survive a restart.
    }
  };

  /**
   * Drag the divider under PINNED to cap the section's height: a long pinned
   * list then scrolls inside the section instead of squeezing PROJECTS out.
   */
  const onPinnedResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    const section = pinnedSectionRef.current;
    const container = section?.parentElement;
    if (!section || !container) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = pinnedMaxHeight ?? section.clientHeight;
    const maxAllowed = Math.max(PINNED_SECTION_MIN, container.clientHeight - PROJECTS_MIN_SPACE);
    const clampHeight = (clientY: number) =>
      Math.min(maxAllowed, Math.max(PINNED_SECTION_MIN, startHeight + (clientY - startY)));
    const onMove = (moveEvent: PointerEvent) => {
      section.style.maxHeight = `${clampHeight(moveEvent.clientY)}px`;
    };
    const onUp = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("pinned-section-resizing");
      section.style.maxHeight = "";
      persistPinnedHeight(clampHeight(upEvent.clientY));
    };
    document.body.classList.add("pinned-section-resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

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
    if (project.primaryRepo) return project.name ?? pathBaseName(project.cwd);
    return pathBaseName(project.cwd);
  };

  /** Callbacks passed to every <SessionRow> (sidebar + flyout variants). */
  const sessionRowCallbacks: SessionRowCallbacks = {
    onSelect,
    onRename,
    onRemove,
    onReload,
    onOpenFolder,
    onCopyText,
    addToChat,
    toggleSessionPin,
  };

  /** One session row in the expanded sidebar. */
  const renderSessionRow = (session: SessionSummary) => (
    <SessionRow
      key={session.path}
      session={session}
      active={session.path === activePath}
      runtime={runtimeStates?.[session.path]}
      pinned={pinnedSessions.has(session.path)}
      completedRun={unseenRuns.has(session.path)}
      platform={platform}
      labelClassName="session-label"
      {...sessionRowCallbacks}
    />
  );

  /** Extra props every collapsed-mode project flyout needs. */
  const flyoutProps = {
    activeSessionPath: activePath,
    runtimeStates,
    pinnedSessions,
    unseenRuns,
    platform,
    toggleProjectPin,
    ...sessionRowCallbacks,
  };

  const showAllSessions = (key: string) => setExpandedSessionProjects((current) => new Set(current).add(key));
  const showLessSessions = (key: string) =>
    setExpandedSessionProjects((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });

  /** One expanded-mode project row: header + session preview + show-more. */
  const renderProjectRow = (project: ProjectGroup) => {
    // Preview the first 5 sessions; "Show more" reveals the rest and "Show
    // less" collapses back. Collapsing the project also resets the expansion
    // (see toggleProject), so re-expanding returns to the preview.
    const visibleSessions = project.sessions.filter((session) => !pinnedSessions.has(session.path));
    const showAll = expandedSessionProjects.has(project.key);
    const shownSessions = visibleSessions.length > 5 && !showAll ? visibleSessions.slice(0, 5) : visibleSessions;
    return (
      <ProjectRow
        key={project.key}
        project={project}
        label={projectLabel(project)}
        pinned={pinnedProjects.has(project.key)}
        sessionCount={visibleSessions.length}
        platform={platform}
        collapsed={isCollapsed(project.key)}
        onToggle={() => toggleProject(project.key)}
        onCreate={onCreate}
        toggleProjectPin={toggleProjectPin}
        onOpenFolder={onOpenFolder}
        onCopyText={onCopyText}
        onEditProject={onEditProject}
        onPromoteProject={onPromoteProject}
        onRemoveProject={onRemoveProject}
        footer={
          <ShowMore
            projectKey={project.key}
            total={visibleSessions.length}
            showAll={showAll}
            onShowAll={showAllSessions}
            onShowLess={showLessSessions}
          />
        }
      >
        {shownSessions.map((session) => renderSessionRow(session))}
      </ProjectRow>
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

        {pinnedSessionList.length > 0 || pinnedProjectList.length > 0 ? (
          state === "collapsed" ? (
            // Icon-only pinned rows: one aggregated pin button for pinned
            // chats and the project avatar flyout for pinned projects.
            <SidebarMenu className="pinned-sessions-collapsed">
              {pinnedSessionList.length > 0 ? (
                <SidebarMenuItem>
                  {/* One aggregated pin button; hovering (or clicking) lists
                          every pinned chat (same flyout pattern as collapsed
                          projects). */}
                  <HoverCard open={pinnedFlyoutOpen} onOpenChange={setPinnedFlyoutOpen} openDelay={120} closeDelay={60}>
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
                        {pinnedSessionList.map((session) => (
                          <SessionRow
                            key={session.path}
                            flyout
                            session={session}
                            active={session.path === activePath}
                            runtime={runtimeStates?.[session.path]}
                            pinned={pinnedSessions.has(session.path)}
                            completedRun={unseenRuns.has(session.path)}
                            platform={platform}
                            labelClassName="project-flyout-session-label"
                            {...sessionRowCallbacks}
                            onSelect={(selected) => {
                              setPinnedFlyoutOpen(false);
                              onSelect(selected);
                            }}
                          />
                        ))}
                      </ul>
                    </HoverCardContent>
                  </HoverCard>
                </SidebarMenuItem>
              ) : null}
              {pinnedProjectList.map((project) => (
                <SidebarMenuItem key={project.key}>
                  <ProjectFlyout
                    project={project}
                    label={projectLabel(project)}
                    projectPinned={pinnedProjects.has(project.key)}
                    onExpand={() => expandToProject(project.cwd)}
                    {...flyoutProps}
                  />
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          ) : (
            <div
              className="pinned-sessions"
              ref={pinnedSectionRef}
              style={pinnedMaxHeight !== undefined ? { maxHeight: pinnedMaxHeight } : undefined}
            >
              <button
                type="button"
                className={`pinned-sessions-label${pinnedCollapsed ? " collapsed" : ""}`}
                onClick={() => setPinnedCollapsed((current) => !current)}
                aria-expanded={!pinnedCollapsed}
              >
                <ChevronDown size={10} className="pinned-sessions-chevron" aria-hidden="true" />
                Pinned
              </button>
              {pinnedCollapsed ? null : (
                <>
                  <SidebarMenu className="pinned-sessions-list">
                    {pinnedSessionList.map((session) => renderSessionRow(session))}
                  </SidebarMenu>
                  {pinnedProjectList.map((project) => renderProjectRow(project))}
                </>
              )}
            </div>
          )
        ) : null}

        {state === "collapsed" ||
        pinnedCollapsed ||
        (pinnedSessionList.length === 0 && pinnedProjectList.length === 0) ? null : (
          <div
            className="pinned-resize-handle"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize Pinned section"
            title="Drag to resize Pinned"
            onPointerDown={onPinnedResizeStart}
          />
        )}

        <SidebarGroup className="sidebar-session-group">
          {state === "collapsed" ? null : (
            <SidebarGroupLabel>
              PROJECTS
              <SidebarGroupAction aria-label="Add project" title="Add project" onClick={onImportProject}>
                <Plus size={12} />
              </SidebarGroupAction>
            </SidebarGroupLabel>
          )}

          <SidebarGroupContent>
            {state === "collapsed" ? (
              <SidebarMenu>
                {/* The default folder gets its own flyout entry ("Home") —
                    its sessions live under Recent, not in a project group. */}
                {homeProject ? (
                  <SidebarMenuItem key={homeProject.key}>
                    <ProjectFlyout
                      project={homeProject}
                      label={pathBaseName(homeProject.cwd)}
                      onExpand={() => expandToProject(homeProject.cwd)}
                      {...flyoutProps}
                    />
                  </SidebarMenuItem>
                ) : null}
                {/* Pinned projects render in the pinned section above (same
                    grouping as the expanded sidebar). */}
                {regularProjects.map((project) => (
                  <SidebarMenuItem key={project.key}>
                    <ProjectFlyout
                      project={project}
                      label={projectLabel(project)}
                      projectPinned={pinnedProjects.has(project.key)}
                      onExpand={() => expandToProject(project.cwd)}
                      {...flyoutProps}
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
              <>
                {regularProjects.map((project) => renderProjectRow(project))}
                {recentSessions.length > 0 ? (
                  <div className="sidebar-recent">
                    <button
                      type="button"
                      className={`sidebar-recent-label${recentCollapsed ? " collapsed" : ""}`}
                      onClick={() => setRecentCollapsed((current) => !current)}
                      aria-expanded={!recentCollapsed}
                    >
                      <ChevronDown size={10} className="sidebar-recent-chevron" aria-hidden="true" />
                      Recent
                    </button>
                    {recentCollapsed ? null : (
                      <SidebarMenu className="sidebar-recent-list">
                        {recentSessions.map((session) => renderSessionRow(session))}
                      </SidebarMenu>
                    )}
                  </div>
                ) : null}
              </>
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
});
