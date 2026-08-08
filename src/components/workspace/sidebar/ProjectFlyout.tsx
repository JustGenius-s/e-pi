import { Pin } from "lucide-react";
import { useState, type CSSProperties } from "react";

import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { SidebarMenuButton } from "@/components/ui/sidebar";

import type { PiRuntimeState } from "../../../types/contracts";
import { SessionRow } from "./SessionRow";
import { projectAvatarColor, type ProjectGroup, type SessionRowCallbacks } from "./shared";

interface ProjectFlyoutProps extends SessionRowCallbacks {
  project: ProjectGroup;
  label: string;
  /** Marks the current session inside the flyout list. */
  activeSessionPath?: string;
  runtimeStates?: Record<string, PiRuntimeState>;
  pinnedSessions: Set<string>;
  /** Sessions whose background run finished; shown with a nav dot. */
  unseenRuns?: ReadonlySet<string>;
  platform?: NodeJS.Platform;
  onExpand: () => void;
  projectPinned: boolean;
  toggleProjectPin: (key: string) => void;
}

/**
 * Collapsed (icon) mode: one folder button per project. Hovering opens a
 * flyout listing the project's sessions — clicking a session switches to it
 * without expanding the sidebar; clicking the folder itself expands the
 * sidebar and opens that project. The header pins the workspace and "+"
 * creates a session in the project directly.
 */
export function ProjectFlyout({
  project,
  label,
  activeSessionPath,
  runtimeStates,
  pinnedSessions,
  unseenRuns,
  platform,
  onExpand,
  projectPinned,
  toggleProjectPin,
  ...sessionCallbacks
}: ProjectFlyoutProps) {
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
            className={`project-flyout-add${projectPinned ? " active" : ""}`}
            aria-label={projectPinned ? "Unpin workspace" : "Pin workspace"}
            title={projectPinned ? "Unpin workspace" : "Pin workspace"}
            onClick={(event) => {
              event.stopPropagation();
              toggleProjectPin(project.key);
            }}
          >
            <Pin size={12} fill={projectPinned ? "currentColor" : "none"} />
          </button>
        </div>
        <ul className="project-flyout-sessions">
          {/* Pinned chats live in the pinned-chats flyout instead (same
              grouping as the expanded sidebar's Pinned section). */}
          {project.sessions
            .filter((session) => !pinnedSessions.has(session.path))
            .map((session) => (
              <SessionRow
                key={session.path}
                flyout
                session={session}
                active={session.path === activeSessionPath}
                runtime={runtimeStates?.[session.path]}
                pinned={pinnedSessions.has(session.path)}
                completedRun={unseenRuns?.has(session.path)}
                platform={platform}
                labelClassName="project-flyout-session-label"
                {...sessionCallbacks}
                onSelect={(selected) => {
                  setOpen(false);
                  sessionCallbacks.onSelect(selected);
                }}
              />
            ))}
        </ul>
      </HoverCardContent>
    </HoverCard>
  );
}
