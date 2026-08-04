import { FolderOpen } from "lucide-react";
import type { SessionSummary } from "../types/contracts";
import { compactPath, sessionTitle } from "../lib/format";
import { IconButton } from "./IconButton";
import { SidebarTrigger } from "./ui/sidebar";

interface AppHeaderProps {
  activeSession?: SessionSummary;
  activeCwd: string;
  onOpenWorkingFolder: () => void;
}

export function AppHeader({ activeSession, activeCwd, onOpenWorkingFolder }: AppHeaderProps) {
  return (
    <header className="topbar">
      <div className="window-drag-region" />
      <div className="brand-lockup">
        <SidebarTrigger />
      </div>
      <div className="topbar-actions">
        <div className="workspace-title">
          <div>
            <h2>{activeSession ? sessionTitle(activeSession) : "Pi workspace"}</h2>
            <span>{activeCwd ? compactPath(activeCwd, 70) : "Choose a session to begin"}</span>
          </div>
        </div>
        <div className="workspace-meta">
          <IconButton
            label="Open working folder"
            onClick={onOpenWorkingFolder}
            disabled={!activeCwd}
          >
            <FolderOpen size={15} />
          </IconButton>
        </div>
      </div>
    </header>
  );
}
