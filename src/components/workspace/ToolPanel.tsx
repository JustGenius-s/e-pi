import { FolderOpen, GitPullRequest, Plus, SquareTerminal, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { memo } from "react";

import { ReviewView } from "@/components/panels/ReviewView";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd, KbdGroup } from "@/components/ui/kbd";

import { FileTreeView } from "./FileTreeView";
import { SideTerminalView } from "./SideTerminalView";

export const PANEL_VIEWS = ["review", "files", "terminal"] as const;
export type PanelView = (typeof PANEL_VIEWS)[number];

/** One open tool-panel tab. */
export interface PanelTab {
  id: string;
  view: PanelView;
}

/** Tabs open in the tool panel plus the one currently shown. */
export interface PanelState {
  tabs: PanelTab[];
  /** Active tab id; undefined when no tabs are open (launch pad shown). */
  activeId: string | undefined;
}

interface ToolPanelProps {
  cwd: string;
  tabs: PanelTab[];
  activeTabId: string | undefined;
  platform?: NodeJS.Platform;
  /** Open a tab; forceNew always creates a fresh one (review stays singleton). */
  onOpenTab: (view: PanelView, forceNew?: boolean) => void;
  onCloseTab: (id: string) => void;
  onSelectTab: (id: string) => void;
}

const VIEW_META: Record<PanelView, { title: string; icon: LucideIcon }> = {
  review: { title: "审阅", icon: GitPullRequest },
  files: { title: "文件", icon: FolderOpen },
  terminal: { title: "终端", icon: SquareTerminal },
};

/** Duplicate views get numbered titles ("文件", "文件 2", …). */
function tabTitle(tabs: PanelTab[], index: number): string {
  const tab = tabs[index];
  const base = VIEW_META[tab.view].title;
  const nth = tabs.slice(0, index).filter((other) => other.view === tab.view).length;
  return nth === 0 ? base : `${base} ${nth + 1}`;
}

const LAUNCH_ITEMS: Array<{ view: PanelView; title: string; icon: LucideIcon; key: string }> = [
  { view: "review", title: "审阅", icon: GitPullRequest, key: "1" },
  { view: "files", title: "文件", icon: FolderOpen, key: "2" },
  { view: "terminal", title: "终端", icon: SquareTerminal, key: "3" },
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

interface TabBarProps {
  tabs: PanelTab[];
  activeTabId: string | undefined;
  onOpenTab: (view: PanelView, forceNew?: boolean) => void;
  onCloseTab: (id: string) => void;
  onSelectTab: (id: string) => void;
}

function TabBar({ tabs, activeTabId, onOpenTab, onCloseTab, onSelectTab }: TabBarProps) {
  const reviewOpen = tabs.some((tab) => tab.view === "review");
  return (
    <div className="tool-tab-bar" role="tablist" aria-label="工具面板标签页">
      {tabs.map((tab, index) => {
        const title = tabTitle(tabs, index);
        const Icon = VIEW_META[tab.view].icon;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === activeTabId}
            className={`tool-tab${tab.id === activeTabId ? " active" : ""}`}
            title={title}
            onClick={() => onSelectTab(tab.id)}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                onCloseTab(tab.id);
              }
            }}
          >
            <Icon size={13} />
            <span className="tool-tab-title">{title}</span>
            <button
              type="button"
              className="tool-tab-close"
              aria-label={`关闭${title}`}
              onClick={(event) => {
                event.stopPropagation();
                onCloseTab(tab.id);
              }}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="tool-tab-add" aria-label="新建标签页" title="新建标签页">
            <Plus size={14} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={4}>
          {!reviewOpen ? (
            <DropdownMenuItem onSelect={() => onOpenTab("review", true)}>
              <GitPullRequest size={13} />
              审阅
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => onOpenTab("files", true)}>
            <FolderOpen size={13} />
            文件
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onOpenTab("terminal", true)}>
            <SquareTerminal size={13} />
            终端
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * Right-hand tool panel, toggled entirely by the topbar button. With no tabs
 * it shows the launch pad (view list); opening a view creates a tab. Tabs
 * switch via the tab bar, whose trailing "+" opens the new-tab type menu
 * (review is a singleton). All tabs stay mounted so switching never loses
 * view state (terminal pty included); inactive ones are merely hidden.
 */
export const ToolPanel = memo(function ToolPanel({
  cwd,
  tabs,
  activeTabId,
  platform,
  onOpenTab,
  onCloseTab,
  onSelectTab,
}: ToolPanelProps) {
  return (
    <div className="tool-panel-body">
      {tabs.length > 0 ? (
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onOpenTab={onOpenTab}
          onCloseTab={onCloseTab}
          onSelectTab={onSelectTab}
        />
      ) : null}
      {tabs.length === 0 ? (
        <LaunchPad platform={platform} onSelect={(view) => onOpenTab(view)} />
      ) : (
        <div className="tool-panel-stack">
          {tabs.map((tab) => (
            <div key={tab.id} className={`tool-panel-view${tab.id === activeTabId ? " active" : ""}`}>
              {tab.view === "review" ? <ReviewView cwd={cwd} /> : null}
              {tab.view === "files" ? <FileTreeView cwd={cwd} /> : null}
              {tab.view === "terminal" ? <SideTerminalView cwd={cwd} /> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
