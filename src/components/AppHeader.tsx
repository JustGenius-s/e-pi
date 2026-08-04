import type { SessionSummary } from "../types/contracts";
import { sessionTitle } from "../lib/format";
import { SidebarTrigger } from "./ui/sidebar";

interface AppHeaderProps {
  activeSession?: SessionSummary;
}

export function AppHeader({ activeSession }: AppHeaderProps) {
  return (
    <header className="topbar">
      <div className="window-drag-region" />
      <div className="brand-lockup">
        <SidebarTrigger />
      </div>
      <div className="topbar-actions">
        <div className="workspace-title">
          <h2>{activeSession ? sessionTitle(activeSession) : "Pi workspace"}</h2>
        </div>
      </div>
    </header>
  );
}
