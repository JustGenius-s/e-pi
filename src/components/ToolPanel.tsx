import { FolderOpen, GitPullRequest, Terminal } from "lucide-react";
import { memo } from "react";

import { FileTreeView } from "./FileTreeView";
import { ReviewView } from "./ReviewView";
import { SideTerminalView } from "./SideTerminalView";
import { Kbd, KbdGroup } from "./ui/kbd";

export const PANEL_VIEWS = ["review", "files", "terminal"] as const;
export type PanelView = (typeof PANEL_VIEWS)[number];

interface ToolPanelProps {
  cwd: string;
  view: PanelView | undefined;
  onViewChange: (view: PanelView | undefined) => void;
  platform?: NodeJS.Platform;
}

const LAUNCH_ITEMS: Array<{ view: PanelView; title: string; icon: typeof GitPullRequest; key: string }> = [
  { view: "review", title: "审阅", icon: GitPullRequest, key: "1" },
  { view: "files", title: "文件", icon: FolderOpen, key: "2" },
  { view: "terminal", title: "终端", icon: Terminal, key: "3" },
];

function LaunchPad({ platform, onSelect }: { platform?: NodeJS.Platform; onSelect: (view: PanelView) => void }) {
  const isMac = platform === "darwin";
  return (
    <div className="tool-launch">
      {LAUNCH_ITEMS.map((item) => (
        <button key={item.view} type="button" className="tool-launch-item" onClick={() => onSelect(item.view)}>
          <item.icon size={15} />
          <span className="tool-launch-item-title">{item.title}</span>
          {isMac ? (
            <KbdGroup>
              <Kbd>⌘</Kbd>
              <Kbd>{item.key}</Kbd>
            </KbdGroup>
          ) : (
            <KbdGroup>
              <Kbd>Ctrl</Kbd>
              <span>+</span>
              <Kbd>{item.key}</Kbd>
            </KbdGroup>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * Right-hand tool panel, toggled entirely by the topbar button. Opening the
 * panel shows the launch pad (view list); each view renders its own content
 * with a slim bottom bar back to the list. No in-panel header.
 */
export const ToolPanel = memo(function ToolPanel({ cwd, view, onViewChange, platform }: ToolPanelProps) {
  return (
    <div className="tool-panel-body">
      {view === undefined ? <LaunchPad platform={platform} onSelect={onViewChange} /> : null}
      {view === "review" ? <ReviewView cwd={cwd} onBack={() => onViewChange(undefined)} /> : null}
      {view === "files" ? <FileTreeView key={cwd} cwd={cwd} onBack={() => onViewChange(undefined)} /> : null}
      {view === "terminal" ? <SideTerminalView key={cwd} cwd={cwd} onBack={() => onViewChange(undefined)} /> : null}
    </div>
  );
});
