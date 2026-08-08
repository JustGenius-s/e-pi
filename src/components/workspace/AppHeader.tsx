import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { memo } from "react";

import { IconButton } from "@/components/ui/IconButton";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";

import { sessionTitle } from "../../lib/format";
import type { SessionSummary } from "../../types/contracts";

interface AppHeaderProps {
  activeSession?: SessionSummary;
  panelOpen: boolean;
  onTogglePanel: () => void;
}

export const AppHeader = memo(function AppHeader({ activeSession, panelOpen, onTogglePanel }: AppHeaderProps) {
  const { state } = useSidebar();
  return (
    <header className="app-topbar" data-collapsed={state === "collapsed" ? "" : undefined}>
      <div className="window-drag-region" />
      <div className="brand-lockup">
        <div className="brand-mark-lockup" aria-label="E-Pi">
          <img className="brand-mark" src="./e-pi-mark.svg" alt="" aria-hidden="true" />
          <span className="brand-name">E-Pi</span>
        </div>
      </div>
      <div className="workspace-title">
        <h2>{activeSession ? sessionTitle(activeSession) : "Pi workspace"}</h2>
      </div>
      <div className="topbar-actions">
        <div className="topbar-panel-toggle">
          <IconButton
            label={panelOpen ? "Collapse panel (⌘G)" : "Expand panel (⌘G)"}
            className={panelOpen ? "topbar-git-toggle active" : "topbar-git-toggle"}
            onClick={onTogglePanel}
          >
            {panelOpen ? <PanelRightOpen size={13} /> : <PanelRightClose size={13} />}
          </IconButton>
        </div>
        <div className="topbar-sidebar-toggle">
          <SidebarTrigger />
        </div>
      </div>
    </header>
  );
});
