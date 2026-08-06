import { useEffect, useRef } from "react";

import { PANEL_VIEWS, type PanelView } from "../components/ToolPanel";

interface GlobalShortcutOptions {
  defaultCwd?: string;
  packageOpen: boolean;
  skillOpen: boolean;
  onNewSession: (cwd?: string) => void;
  onClosePackages: () => void;
  onCloseSkills: () => void;
  onTogglePanel: () => void;
  onOpenPanelTab: (view: PanelView) => void;
}

/** Owns window-level shortcuts so App remains focused on application composition. */
export function useGlobalShortcuts({
  defaultCwd,
  packageOpen,
  skillOpen,
  onNewSession,
  onClosePackages,
  onCloseSkills,
  onTogglePanel,
  onOpenPanelTab,
}: GlobalShortcutOptions): void {
  const optionsRef = useRef({
    defaultCwd,
    packageOpen,
    skillOpen,
    onNewSession,
    onClosePackages,
    onCloseSkills,
    onTogglePanel,
    onOpenPanelTab,
  });
  optionsRef.current = {
    defaultCwd,
    packageOpen,
    skillOpen,
    onNewSession,
    onClosePackages,
    onCloseSkills,
    onTogglePanel,
    onOpenPanelTab,
  };

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const options = optionsRef.current;
      const modified = event.metaKey || event.ctrlKey;
      if (modified && event.key.toLowerCase() === "n") {
        event.preventDefault();
        options.onNewSession(options.defaultCwd);
      }
      if (event.key === "Escape" && options.packageOpen) options.onClosePackages();
      if (event.key === "Escape" && options.skillOpen) options.onCloseSkills();
      if (modified && event.key.toLowerCase() === "g") {
        event.preventDefault();
        options.onTogglePanel();
      }
      if (modified && /^[1-9]$/.test(event.key)) {
        const target = PANEL_VIEWS[Number(event.key) - 1];
        if (target) {
          event.preventDefault();
          options.onOpenPanelTab(target);
        }
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
}
