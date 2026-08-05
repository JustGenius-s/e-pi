import { FolderOpen, GitPullRequest, Terminal } from "lucide-react";
import { memo, useState } from "react";

import { FileTreeView } from "./FileTreeView";
import { ReviewView } from "./ReviewView";
import { SideTerminalView } from "./SideTerminalView";

interface ToolPanelProps {
  cwd: string;
}

type PanelView = "review" | "files" | "terminal";

const LAUNCH_ITEMS: Array<{
  view: PanelView;
  title: string;
  description: string;
  icon: typeof GitPullRequest;
}> = [
  { view: "review", title: "审阅", description: "查看代码变更、提交与推送", icon: GitPullRequest },
  { view: "files", title: "文件", description: "浏览项目文件与内容预览", icon: FolderOpen },
  { view: "terminal", title: "终端", description: "在项目目录运行 shell", icon: Terminal },
];

function LaunchPad({ onSelect }: { onSelect: (view: PanelView) => void }) {
  return (
    <div className="tool-launch">
      <div className="tool-launch-cards">
        {LAUNCH_ITEMS.map((item) => (
          <button key={item.view} type="button" className="tool-launch-card" onClick={() => onSelect(item.view)}>
            <item.icon size={16} />
            <span className="tool-launch-card-title">{item.title}</span>
            <span className="tool-launch-card-desc">{item.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Right-hand tool panel, toggled entirely by the topbar button. Opening the
 * panel shows the launch pad (view list); each view renders its own content
 * with a slim bottom bar back to the list. No in-panel header.
 */
export const ToolPanel = memo(function ToolPanel({ cwd }: ToolPanelProps) {
  const [view, setView] = useState<PanelView>();

  return (
    <div className="tool-panel-body">
      {view === undefined ? <LaunchPad onSelect={setView} /> : null}
      {view === "review" ? <ReviewView cwd={cwd} onBack={() => setView(undefined)} /> : null}
      {view === "files" ? <FileTreeView key={cwd} cwd={cwd} onBack={() => setView(undefined)} /> : null}
      {view === "terminal" ? <SideTerminalView key={cwd} cwd={cwd} onBack={() => setView(undefined)} /> : null}
    </div>
  );
});
