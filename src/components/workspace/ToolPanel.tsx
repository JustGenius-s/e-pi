import { FolderOpen, GitPullRequest, Plus, SquareTerminal, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";

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
  /** Git repos of the current project; drives the review repo switcher. */
  repos?: string[];
  /** The project's primary repo (starred in the switcher). */
  primaryRepo?: string;
  tabs: PanelTab[];
  activeTabId: string | undefined;
  platform?: NodeJS.Platform;
  /** Open a tab; forceNew always creates a fresh one (review stays singleton). */
  onOpenTab: (view: PanelView, forceNew?: boolean) => void;
  onCloseTab: (id: string) => void;
  onSelectTab: (id: string) => void;
  /** Open a workspace file (preview/editor routing). */
  onOpenFile?: (path: string, imagePaths?: string[]) => void;
}

const VIEW_META: Record<PanelView, { title: string; icon: LucideIcon }> = {
  review: { title: "Review", icon: GitPullRequest },
  files: { title: "Files", icon: FolderOpen },
  terminal: { title: "Terminal", icon: SquareTerminal },
};

/** Duplicate views get numbered titles ("Files", "Files 2", …). */
function tabTitle(tabs: PanelTab[], index: number): string {
  const tab = tabs[index];
  const base = VIEW_META[tab.view].title;
  const nth = tabs.slice(0, index).filter((other) => other.view === tab.view).length;
  return nth === 0 ? base : `${base} ${nth + 1}`;
}

const LAUNCH_ITEMS: Array<{ view: PanelView; title: string; icon: LucideIcon; key: string }> = [
  { view: "review", title: "Review", icon: GitPullRequest, key: "1" },
  { view: "files", title: "Files", icon: FolderOpen, key: "2" },
  { view: "terminal", title: "Terminal", icon: SquareTerminal, key: "3" },
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
    <div className="tool-tab-bar" role="tablist" aria-label="Tool panel tabs">
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
              aria-label={`Close ${title}`}
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
          <button type="button" className="tool-tab-add" aria-label="New tab" title="New tab">
            <Plus size={14} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={4}>
          {!reviewOpen ? (
            <DropdownMenuItem onSelect={() => onOpenTab("review", true)}>
              <GitPullRequest size={13} />
              Review
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => onOpenTab("files", true)}>
            <FolderOpen size={13} />
            Files
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onOpenTab("terminal", true)}>
            <SquareTerminal size={13} />
            Terminal
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
  repos,
  primaryRepo,
  tabs,
  activeTabId,
  platform,
  onOpenTab,
  onCloseTab,
  onSelectTab,
  onOpenFile,
}: ToolPanelProps) {
  // The review target follows the active session, but stays put when the user
  // picked a different repo from the switcher — until it no longer belongs to
  // the current project's repo set.
  const [reviewCwd, setReviewCwd] = useState<string | undefined>();
  useEffect(() => {
    setReviewCwd((current) => (current && repos?.includes(current) ? current : cwd));
  }, [cwd, repos]);
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
              {tab.view === "review" ? (
                <ReviewView
                  cwd={reviewCwd ?? cwd}
                  repos={repos}
                  primaryRepo={primaryRepo}
                  onSelectRepo={setReviewCwd}
                />
              ) : null}
              {tab.view === "files" ? <FileTreeView cwd={cwd} onOpenFile={onOpenFile} /> : null}
              {tab.view === "terminal" ? <SideTerminalView cwd={cwd} /> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
