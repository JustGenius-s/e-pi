"use client";

import { PanelLeft } from "lucide-react";
import { Slot } from "radix-ui";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type SidebarState = "expanded" | "collapsed";

type SidebarSide = "left" | "right";

/** Drag-to-resize bounds for the sidebar rail (px). */
const SIDEBAR_WIDTH_MIN = 256;
const SIDEBAR_WIDTH_MAX = 520;
/** The right-hand tool panel may grow twice as wide as the left sidebar. */
const SIDEBAR_WIDTH_RIGHT_MAX = SIDEBAR_WIDTH_MAX * 2;
const SIDEBAR_WIDTH_DEFAULT = 320;
// v2: old key was bumped so previously saved test widths (which would
// otherwise override the new default) are ignored. Sidebars keep their own
// key so left/right widths don't clobber each other.
const SIDEBAR_WIDTH_STORAGE_KEY = "sidebar-width-v2";

const clampSidebarWidth = (width: number, max: number) => Math.min(max, Math.max(SIDEBAR_WIDTH_MIN, width));

function readSavedSidebarWidth(storageKey: string, max: number): number {
  try {
    // getItem returns null when the key is absent — Number(null) is 0, which
    // would clamp to the minimum. Only accept real stored values.
    const saved = window.localStorage.getItem(storageKey);
    if (saved !== null) {
      const parsed = Number(saved);
      if (Number.isFinite(parsed)) return clampSidebarWidth(parsed, max);
    }
  } catch {
    // Storage unavailable (tests, hardened environments) — use the default.
  }
  return SIDEBAR_WIDTH_DEFAULT;
}

interface SidebarContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  state: SidebarState;
  side: SidebarSide;
  /** Current target sidebar width in px (what --sidebar-width resolves to). */
  getWidth: () => number;
  /**
   * Update the sidebar width. Live drags pass persist=false (direct DOM
   * update, no re-render); the drag end commits with persist=true.
   */
  applyWidth: (width: number, persist: boolean) => void;
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) throw new Error("useSidebar must be used within a SidebarProvider");
  return context;
}

function SidebarProvider({
  open: openProp,
  defaultOpen = true,
  onOpenChange,
  side = "left",
  storageKey = SIDEBAR_WIDTH_STORAGE_KEY,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: SidebarSide;
  /** LocalStorage key for the persisted width; per-side keys avoid clobbering. */
  storageKey?: string;
}) {
  const [openState, setOpenState] = React.useState(defaultOpen);
  const open = openProp ?? openState;
  const setOpen = React.useCallback(
    (value: boolean) => {
      if (openProp === undefined) setOpenState(value);
      onOpenChange?.(value);
    },
    [onOpenChange, openProp],
  );
  const toggleSidebar = React.useCallback(() => setOpen(!open), [open, setOpen]);
  const state: SidebarState = open ? "expanded" : "collapsed";

  const [width, setWidth] = React.useState(() =>
    readSavedSidebarWidth(storageKey, side === "right" ? SIDEBAR_WIDTH_RIGHT_MAX : SIDEBAR_WIDTH_MAX),
  );
  const widthRef = React.useRef(width);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const getWidth = React.useCallback(() => widthRef.current, []);
  const applyWidth = React.useCallback(
    (next: number, persist: boolean) => {
      const clamped = clampSidebarWidth(next, side === "right" ? SIDEBAR_WIDTH_RIGHT_MAX : SIDEBAR_WIDTH_MAX);
      widthRef.current = clamped;
      // Live drags mutate the CSS variable directly so React never re-renders
      // per pointermove (the wrapper re-renders often; a stale style prop would
      // otherwise reset the width mid-drag, but React only writes style props
      // that actually changed, so the direct mutation survives until commit).
      wrapperRef.current?.style.setProperty("--sidebar-width", `${clamped}px`);
      if (persist) {
        setWidth(clamped);
        try {
          window.localStorage.setItem(storageKey, String(Math.round(clamped)));
        } catch {
          // Storage unavailable — width just won't survive a restart.
        }
      }
    },
    [storageKey, side],
  );

  const contextValue = React.useMemo(
    () => ({ open, setOpen, toggleSidebar, state, side, getWidth, applyWidth }),
    [open, setOpen, toggleSidebar, state, side, getWidth, applyWidth],
  );

  return (
    <SidebarContext.Provider value={contextValue}>
      <div
        ref={wrapperRef}
        data-slot="sidebar-wrapper"
        style={
          {
            "--sidebar-width": `${width}px`,
            "--sidebar-width-icon": "3rem",
            ...style,
          } as React.CSSProperties
        }
        className={cn("sidebar-layout", className)}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

function Sidebar({
  side = "left",
  collapsible = "icon",
  className,
  children,
  ...props
}: React.ComponentProps<"aside"> & {
  side?: "left" | "right";
  collapsible?: "offcanvas" | "icon" | "none";
}) {
  const { state } = useSidebar();
  if (collapsible === "none") {
    return (
      <aside
        data-slot="sidebar"
        data-side={side}
        data-state="expanded"
        className={cn("sidebar-root", className)}
        {...props}
      >
        {children}
      </aside>
    );
  }
  return (
    <aside
      data-slot="sidebar"
      data-side={side}
      data-state={state}
      data-collapsible={collapsible}
      className={cn("sidebar-root", className)}
      {...props}
    >
      <div data-slot="sidebar-container" className="sidebar-container">
        {children}
      </div>
    </aside>
  );
}

function SidebarTrigger({ className, onClick, ...props }: React.ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar();
  return (
    <Button
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon-sm"
      className={cn("sidebar-trigger", className)}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) toggleSidebar();
      }}
      {...props}
    >
      <PanelLeft />
      <span className="sr-only">Toggle sidebar</span>
    </Button>
  );
}

function SidebarRail({ className, onClick, ...props }: React.ComponentProps<"button">) {
  const { state, side, setOpen, toggleSidebar, getWidth, applyWidth } = useSidebar();
  const [resizing, setResizing] = React.useState(false);
  const drag = React.useRef<{ startX: number; startWidth: number; moved: number } | undefined>(undefined);
  /** A real drag must not also fire the click-to-toggle. */
  const suppressClick = React.useRef(false);
  /** Dragging the right edge of a left sidebar widens it; mirrored for right. */
  const direction = side === "right" ? -1 : 1;

  return (
    <button
      data-slot="sidebar-rail"
      data-resizing={resizing ? "true" : undefined}
      aria-label="Toggle sidebar"
      tabIndex={-1}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        // Dragging the edge of a collapsed sidebar expands it first, like
        // most IDEs, so the drag starts from the target (expanded) width.
        if (state === "collapsed") setOpen(true);
        drag.current = {
          startX: event.clientX,
          startWidth: getWidth(),
          moved: 0,
        };
        suppressClick.current = false;
        event.currentTarget.setPointerCapture(event.pointerId);
        setResizing(true);
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (!active) return;
        const delta = event.clientX - active.startX;
        active.moved = Math.max(active.moved, Math.abs(delta));
        applyWidth(active.startWidth + delta * direction, false);
      }}
      onPointerUp={(event) => {
        const active = drag.current;
        if (!active) return;
        drag.current = undefined;
        setResizing(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        // Commit the final width to React state and localStorage so it
        // survives re-renders and restarts.
        if (active.moved >= 1) {
          applyWidth(active.startWidth + (event.clientX - active.startX) * direction, true);
        }
        suppressClick.current = active.moved >= 4;
      }}
      onPointerCancel={() => {
        drag.current = undefined;
        setResizing(false);
      }}
      onClick={(event) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          event.preventDefault();
          return;
        }
        onClick?.(event);
        if (!event.defaultPrevented) toggleSidebar();
      }}
      className={cn("sidebar-rail", className)}
      {...props}
    />
  );
}

function SidebarInset({ className, ...props }: React.ComponentProps<"main">) {
  return <main data-slot="sidebar-inset" className={cn("sidebar-inset", className)} {...props} />;
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-header" className={cn("sidebar-header", className)} {...props} />;
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-footer" className={cn("sidebar-footer", className)} {...props} />;
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-content" className={cn("sidebar-content", className)} {...props} />;
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-group" className={cn("sidebar-group", className)} {...props} />;
}

function SidebarGroupLabel({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-group-label" className={cn("sidebar-group-label", className)} {...props} />;
}

function SidebarGroupAction({ className, ...props }: React.ComponentProps<"button">) {
  return <button data-slot="sidebar-group-action" className={cn("sidebar-group-action", className)} {...props} />;
}

function SidebarGroupContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-group-content" className={cn("sidebar-group-content", className)} {...props} />;
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return <ul data-slot="sidebar-menu" className={cn("sidebar-menu", className)} {...props} />;
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return <li data-slot="sidebar-menu-item" className={cn("sidebar-menu-item", className)} {...props} />;
}

function SidebarMenuButton({
  asChild = false,
  isActive = false,
  tooltip,
  className,
  ...props
}: React.ComponentProps<"button"> & {
  asChild?: boolean;
  isActive?: boolean;
  tooltip?: string;
}) {
  const { state } = useSidebar();
  const Comp = asChild ? Slot.Root : "button";
  const button = (
    <Comp
      data-slot="sidebar-menu-button"
      data-active={isActive}
      aria-current={isActive ? "page" : undefined}
      className={cn("sidebar-menu-button", className)}
      {...props}
    />
  );
  if (!tooltip) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right" hidden={state !== "collapsed"}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

function SidebarMenuAction({
  className,
  showOnHover = false,
  ...props
}: React.ComponentProps<"button"> & { showOnHover?: boolean }) {
  return (
    <button
      data-slot="sidebar-menu-action"
      data-show-on-hover={showOnHover}
      className={cn("sidebar-menu-action", className)}
      {...props}
    />
  );
}

function SidebarMenuBadge({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="sidebar-menu-badge" className={cn("sidebar-menu-badge", className)} {...props} />;
}

function SidebarInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  return <Input data-slot="sidebar-input" className={cn("sidebar-input", className)} {...props} />;
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
};
