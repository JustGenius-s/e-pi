import { Archive, MoreVertical, Pin } from "lucide-react";
import { useState } from "react";

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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { compactPath, relativeTime, sessionTitle } from "../../../lib/format";
import type { PiRuntimeState, SessionSummary } from "../../../types/contracts";
import { ActivityIndicator } from "./activity";
import { UNKNOWN_FOLDER, type SessionRowCallbacks } from "./shared";

interface SessionRowProps extends SessionRowCallbacks {
  session: SessionSummary;
  active: boolean;
  runtime?: PiRuntimeState;
  pinned: boolean;
  platform?: NodeJS.Platform;
  /** Extra class for the label span (sidebar vs. flyout ellipsis styling). */
  labelClassName: string;
  /** A background run finished while this session wasn't focused: show the nav dot. */
  completedRun?: boolean;
  /** Rendered as the flyout <li> wrapper instead of SidebarMenuItem. */
  flyout?: boolean;
}

/**
 * One session row — the single component used both in the expanded sidebar
 * (as a SidebarMenuItem) and inside the collapsed-mode project flyouts (as a
 * flyout list item). Both get the same content, context menu, and hover
 * action bar (more / pin / archive).
 */
export function SessionRow({
  session,
  active,
  runtime,
  pinned,
  platform,
  labelClassName,
  completedRun,
  flyout,
  onSelect,
  onRename,
  onRemove,
  onOpenFolder,
  onCopyText,
  addToChat,
  toggleSessionPin,
}: SessionRowProps) {
  /**
   * While the row's "more actions" dropdown is open the action bar stays
   * visible even when the pointer leaves the row. Local state keeps each
   * row independent (flyout rows live outside the sidebar's state).
   */
  const [moreOpen, setMoreOpen] = useState(false);
  const title = sessionTitle(session);
  // The run-finished dot replaces the relative time so the cue can't be
  // missed; selecting the session consumes it (useUnseenRunCompletions).
  const trailing = completedRun ? (
    <span className="session-run-dot" title="Run finished — click to view" aria-label="Run finished — click to view" />
  ) : (
    <time dateTime={session.modifiedAt}>{relativeTime(session.modifiedAt)}</time>
  );
  const body = (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {flyout ? (
            <button
              type="button"
              className={`session-menu-button project-flyout-session${active ? " active" : ""}`}
              data-active={active ? "true" : undefined}
              aria-current={active ? "page" : undefined}
              title={compactPath(session.cwd || UNKNOWN_FOLDER, 70)}
              onClick={() => onSelect(session)}
            >
              <ActivityIndicator runtime={runtime} />
              <span className={labelClassName}>{title}</span>
              {trailing}
            </button>
          ) : (
            <SidebarMenuButton
              className="session-menu-button"
              isActive={active}
              tooltip={title}
              title={compactPath(session.cwd || UNKNOWN_FOLDER, 70)}
              onClick={() => onSelect(session)}
            >
              <ActivityIndicator runtime={runtime} />
              <span className={labelClassName}>{title}</span>
              {trailing}
            </SidebarMenuButton>
          )}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => toggleSessionPin(session.path)}>
            {pinned ? "Unpin chat" : "Pin chat"}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onRename(session)}>Rename chat</ContextMenuItem>
          <ContextMenuSeparator />
          {platform === "darwin" && (
            <ContextMenuItem onSelect={() => session.cwd && onOpenFolder(session.cwd)}>Open in Finder</ContextMenuItem>
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
      <div className="session-row-actions" data-open={moreOpen ? "true" : undefined}>
        <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
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
    </>
  );
  return flyout ? (
    <li className="session-menu-item project-flyout-item">{body}</li>
  ) : (
    <SidebarMenuItem className="session-menu-item">{body}</SidebarMenuItem>
  );
}
