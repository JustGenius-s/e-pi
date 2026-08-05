import { PanelRightClose, PanelRightOpen } from "lucide-react";

import { sessionTitle } from "../lib/format";
import type { SessionSummary } from "../types/contracts";
import { IconButton } from "./IconButton";
import { SidebarTrigger } from "./ui/sidebar";

interface AppHeaderProps {
  activeSession?: SessionSummary;
  panelOpen: boolean;
  onTogglePanel: () => void;
}

export function AppHeader({ activeSession, panelOpen, onTogglePanel }: AppHeaderProps) {
  return (
    <header className="topbar">
      <div className="window-drag-region" />
      <div className="brand-lockup">
        <SidebarTrigger />
        <div className="brand-mark-lockup" aria-label="E-Pi">
          <img className="brand-mark" src="./e-pi-mark.svg" alt="" aria-hidden="true" />
          <span className="brand-name">E-Pi</span>
        </div>
      </div>
      <div className="topbar-actions">
        <div className="workspace-title">
          <h2>{activeSession ? sessionTitle(activeSession) : "Pi workspace"}</h2>
        </div>
        <div className="topbar-panel-toggle">
          <IconButton
            label={panelOpen ? "收起面板 (⌘G)" : "展开面板 (⌘G)"}
            className={panelOpen ? "topbar-git-toggle active" : "topbar-git-toggle"}
            onClick={onTogglePanel}
          >
            {panelOpen ? <PanelRightOpen size={13} /> : <PanelRightClose size={13} />}
          </IconButton>
        </div>
      </div>
    </header>
  );
}
