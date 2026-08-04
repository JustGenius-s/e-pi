import {
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Package,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { PiProcessStatus, SessionSummary } from "../types/contracts";
import { compactPath, relativeTime, sessionTitle, statusTone } from "../lib/format";
import { IconButton } from "./IconButton";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "./ui/sidebar";

interface SessionSidebarProps {
  sessions: SessionSummary[];
  activePath?: string;
  runtimeStatus: PiProcessStatus;
  onSelect: (session: SessionSummary) => void;
  onCreate: () => void;
  onRename: (session: SessionSummary) => void;
  onRemove: (session: SessionSummary) => void;
  onOpenPackages: () => void;
  onOpenSkills: () => void;
  onOpenSettings: () => void;
}

export function SessionSidebar({
  sessions,
  activePath,
  runtimeStatus,
  onSelect,
  onCreate,
  onRename,
  onRemove,
  onOpenPackages,
  onOpenSkills,
  onOpenSettings,
}: SessionSidebarProps) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return sessions;
    return sessions.filter((session) => session.searchText.toLowerCase().includes(normalized));
  }, [query, sessions]);

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
          <SidebarGroupLabel>Sessions</SidebarGroupLabel>
          <div className="sidebar-session-toolbar">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  className="sidebar-new-button"
                  tooltip="New session"
                  onClick={onCreate}
                >
                  <Plus />
                  <span>New session</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>

            <label className="sidebar-search">
              <Search size={14} />
              <span className="sr-only">Search sessions</span>
              <SidebarInput
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search"
                type="search"
              />
            </label>
          </div>
          <SidebarGroupContent>
            {filtered.length === 0 ? (
              <div className="sidebar-empty">
                {sessions.length === 0 ? "No sessions yet" : "No matches"}
              </div>
            ) : (
              <SidebarMenu>
                {filtered.map((session) => {
                  const active = session.path === activePath;
                  const title = sessionTitle(session);
                  return (
                    <SidebarMenuItem key={session.path} className="session-menu-item">
                      <SidebarMenuButton
                        className="session-menu-button"
                        isActive={active}
                        tooltip={title}
                        title={compactPath(session.cwd || "Unknown folder", 70)}
                        onClick={() => onSelect(session)}
                      >
                        <span className="session-icon" aria-hidden="true">
                          <MessageSquare size={15} />
                          <span
                            className={`session-status ${active ? statusTone(runtimeStatus) : "muted"}`}
                          />
                        </span>
                        <span className="session-label">{title}</span>
                        <time dateTime={session.modifiedAt}>
                          {relativeTime(session.modifiedAt)}
                        </time>
                      </SidebarMenuButton>
                      <div className="session-menu-actions">
                        <IconButton label={`Rename ${title}`} onClick={() => onRename(session)}>
                          <Pencil size={12} />
                        </IconButton>
                        <IconButton
                          label={`Move ${title} to Trash`}
                          onClick={() => onRemove(session)}
                        >
                          <Trash2 size={12} />
                        </IconButton>
                      </div>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
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
