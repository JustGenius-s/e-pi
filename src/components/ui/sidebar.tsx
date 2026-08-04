"use client"

import * as React from "react"
import { PanelLeft } from "lucide-react"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

type SidebarState = "expanded" | "collapsed"

interface SidebarContextValue {
  open: boolean
  setOpen: (open: boolean) => void
  toggleSidebar: () => void
  state: SidebarState
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null)

function useSidebar() {
  const context = React.useContext(SidebarContext)
  if (!context) throw new Error("useSidebar must be used within a SidebarProvider")
  return context
}

function SidebarProvider({
  open: openProp,
  defaultOpen = true,
  onOpenChange,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const [openState, setOpenState] = React.useState(defaultOpen)
  const open = openProp ?? openState
  const setOpen = React.useCallback((value: boolean) => {
    if (openProp === undefined) setOpenState(value)
    onOpenChange?.(value)
  }, [onOpenChange, openProp])
  const toggleSidebar = React.useCallback(() => setOpen(!open), [open, setOpen])
  const state: SidebarState = open ? "expanded" : "collapsed"

  return (
    <SidebarContext.Provider value={{ open, setOpen, toggleSidebar, state }}>
      <div
        data-slot="sidebar-wrapper"
        style={{
          "--sidebar-width": "16rem",
          "--sidebar-width-icon": "3rem",
          ...style,
        } as React.CSSProperties}
        className={cn("sidebar-layout", className)}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  )
}

function Sidebar({
  side = "left",
  collapsible = "icon",
  className,
  children,
  ...props
}: React.ComponentProps<"aside"> & {
  side?: "left" | "right"
  collapsible?: "offcanvas" | "icon" | "none"
}) {
  const { state } = useSidebar()
  if (collapsible === "none") {
    return <aside data-slot="sidebar" data-side={side} data-state="expanded" className={cn("sidebar-root", className)} {...props}>{children}</aside>
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
  )
}

function SidebarTrigger({ className, onClick, ...props }: React.ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar()
  return (
    <Button
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon-sm"
      className={cn("sidebar-trigger", className)}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) toggleSidebar()
      }}
      {...props}
    >
      <PanelLeft />
      <span className="sr-only">Toggle sidebar</span>
    </Button>
  )
}

function SidebarRail({ className, onClick, ...props }: React.ComponentProps<"button">) {
  const { toggleSidebar } = useSidebar()
  return <button data-slot="sidebar-rail" aria-label="Toggle sidebar" tabIndex={-1} onClick={(event) => {
    onClick?.(event)
    if (!event.defaultPrevented) toggleSidebar()
  }} className={cn("sidebar-rail", className)} {...props} />
}

function SidebarInset({ className, ...props }: React.ComponentProps<"main">) {
  return <main data-slot="sidebar-inset" className={cn("sidebar-inset", className)} {...props} />
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-header" className={cn("sidebar-header", className)} {...props} />
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-footer" className={cn("sidebar-footer", className)} {...props} />
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-content" className={cn("sidebar-content", className)} {...props} />
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-group" className={cn("sidebar-group", className)} {...props} />
}

function SidebarGroupLabel({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-group-label" className={cn("sidebar-group-label", className)} {...props} />
}

function SidebarGroupAction({ className, ...props }: React.ComponentProps<"button">) {
  return <button data-slot="sidebar-group-action" className={cn("sidebar-group-action", className)} {...props} />
}

function SidebarGroupContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-group-content" className={cn("sidebar-group-content", className)} {...props} />
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return <ul data-slot="sidebar-menu" className={cn("sidebar-menu", className)} {...props} />
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return <li data-slot="sidebar-menu-item" className={cn("sidebar-menu-item", className)} {...props} />
}

function SidebarMenuButton({
  asChild = false,
  isActive = false,
  tooltip,
  className,
  ...props
}: React.ComponentProps<"button"> & {
  asChild?: boolean
  isActive?: boolean
  tooltip?: string
}) {
  const { state } = useSidebar()
  const Comp = asChild ? Slot.Root : "button"
  const button = (
    <Comp
      data-slot="sidebar-menu-button"
      data-active={isActive}
      aria-current={isActive ? "page" : undefined}
      className={cn("sidebar-menu-button", className)}
      {...props}
    />
  )
  if (!tooltip) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right" hidden={state !== "collapsed"}>{tooltip}</TooltipContent>
    </Tooltip>
  )
}

function SidebarMenuAction({ className, showOnHover = false, ...props }: React.ComponentProps<"button"> & { showOnHover?: boolean }) {
  return <button data-slot="sidebar-menu-action" data-show-on-hover={showOnHover} className={cn("sidebar-menu-action", className)} {...props} />
}

function SidebarMenuBadge({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="sidebar-menu-badge" className={cn("sidebar-menu-badge", className)} {...props} />
}

function SidebarInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  return <Input data-slot="sidebar-input" className={cn("sidebar-input", className)} {...props} />
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
}
