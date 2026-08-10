import { ArrowLeft } from "lucide-react";
import { useEffect } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { useImeComposition } from "../../hooks/useImeComposition";
import { pathBaseName, sessionTitle } from "../../lib/format";
import type { AppInfo, ArchivedSessionSummary, Project, SessionSummary } from "../../types/contracts";
import { ArchivedChatsSettings } from "./ArchivedChatsSettings";
import { CommonSettings } from "./CommonSettings";
import { EditorSettings } from "./EditorSettings";
import { FontSettings } from "./FontSettings";
import { ModelSettings } from "./ModelSettings";
import { PiAgentSettings } from "./PiAgentSettings";
import { QuickCommandsSettings } from "./QuickCommandsSettings";

interface RenameInputProps {
  value: string;
  onChange: (name: string) => void;
  onCommit: () => void;
}

/**
 * Session-name field. Enter commits the rename unless an IME composition is
 * in progress (e.g. Chinese pinyin candidate selection). Tracks the
 * composition session ourselves because on macOS the committing Enter keydown
 * can arrive *after* compositionend with isComposing already false; the
 * deferred reset keeps the guard armed through that keydown (WebKit bug
 * 165004, also observable in Electron).
 */
function RenameInput({ value, onChange, onCommit }: RenameInputProps) {
  const { onCompositionStart, onCompositionEnd, isComposing } = useImeComposition();
  return (
    <Input
      autoFocus
      value={value}
      aria-label="Session name"
      // Focus lands with the whole name selected: typing replaces it, and
      // this covers every entry point (context menu, double-click) since
      // they all open the same dialog.
      onFocus={(event) => event.target.select()}
      onChange={(event) => onChange(event.target.value)}
      onCompositionStart={onCompositionStart}
      onCompositionEnd={onCompositionEnd}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || isComposing(event)) return;
        event.preventDefault();
        onCommit();
      }}
    />
  );
}

interface AppDialogsProps {
  renameTarget?: SessionSummary;
  renameName: string;
  onRenameNameChange: (name: string) => void;
  onCommitRename: () => void;
  onCloseRename: () => void;
  removeTarget?: SessionSummary;
  onConfirmRemove: () => void;
  onCloseRemove: () => void;
  /** Project group (multi-folder or implicit) pending removal; its sessions go to the Trash. */
  removeProjectTarget?: { project?: Project; cwd: string; sessions: SessionSummary[] };
  onConfirmRemoveProject: () => void;
  onCloseRemoveProject: () => void;
  /** Archived chats (Settings → Archived); restored/deleted from there. */
  archivedSessions: ArchivedSessionSummary[];
  onUnarchiveArchived: (session: ArchivedSessionSummary) => void;
  onDeleteArchived: (session: ArchivedSessionSummary) => void;
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
  appInfo?: AppInfo;
  /** Called when E-Pi-level settings (e.g. default folder) changed. */
  onAppInfoChange: () => void;
}

export function AppDialogs({
  renameTarget,
  renameName,
  onRenameNameChange,
  onCommitRename,
  onCloseRename,
  removeTarget,
  onConfirmRemove,
  onCloseRemove,
  removeProjectTarget,
  onConfirmRemoveProject,
  onCloseRemoveProject,
  archivedSessions,
  onUnarchiveArchived,
  onDeleteArchived,
  settingsOpen,
  onSettingsOpenChange,
  appInfo,
  onAppInfoChange,
}: AppDialogsProps) {
  // The settings overlay replaced the settings dialog: provide the Escape
  // key behavior the dialog used to have for free.
  useEffect(() => {
    if (!settingsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        window.ePi.models.cancelLogin();
        onSettingsOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [settingsOpen, onSettingsOpenChange]);

  /** Removal message for the pending project group; empty when nothing pending. */
  const removeProjectMessage = (() => {
    if (!removeProjectTarget) return "";
    const count = removeProjectTarget.sessions.length;
    const name = removeProjectTarget.project?.name ?? pathBaseName(removeProjectTarget.cwd);
    // A project can outlive all of its sessions (archived one by one);
    // removing the empty group only drops it from the sidebar.
    if (count === 0) return `${name} will be removed from the sidebar.`;
    return removeProjectTarget.project
      ? `${name} and its ${count} session${count === 1 ? "" : "s"} will be moved to Archived chats.`
      : `${count} session${count === 1 ? "" : "s"} in ${name} will be moved to Archived chats.`;
  })();

  return (
    <>
      <Dialog open={Boolean(renameTarget)} onOpenChange={(open) => !open && onCloseRename()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename session</DialogTitle>
            <DialogDescription>Give this session a short name so it is easier to find later.</DialogDescription>
          </DialogHeader>
          <RenameInput value={renameName} onChange={onRenameNameChange} onCommit={onCommitRename} />
          <DialogFooter>
            <Button variant="outline" onClick={onCloseRename}>
              Cancel
            </Button>
            <Button onClick={onCommitRename} disabled={!renameName.trim()}>
              Save name
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(removeTarget)} onOpenChange={(open) => !open && onCloseRemove()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive session?</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget ? sessionTitle(removeTarget) : "This session"} will be moved to Archived chats. You can
              restore it anytime in Settings → Archived.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmRemove}>Archive</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(removeProjectTarget)} onOpenChange={(open) => !open && onCloseRemoveProject()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove project?</AlertDialogTitle>
            <AlertDialogDescription>{removeProjectMessage}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmRemoveProject}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {settingsOpen ? (
        <div className="settings-overlay" role="dialog" aria-label="Settings">
          <div className="settings-overlay-header">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Back to sessions"
              title="Back to sessions"
              onClick={() => {
                window.ePi.models.cancelLogin();
                onSettingsOpenChange(false);
              }}
            >
              <ArrowLeft size={16} />
            </Button>
            <div className="settings-overlay-title">
              <h2>Settings</h2>
              <p>Manage models and application details.</p>
            </div>
          </div>
          <Tabs className="settings-tabs" defaultValue="models">
            <TabsList variant="line">
              <TabsTrigger value="models">Models</TabsTrigger>
              <TabsTrigger value="general">General</TabsTrigger>
              <TabsTrigger value="composer">Composer</TabsTrigger>
              <TabsTrigger value="archived">Archived</TabsTrigger>
              <TabsTrigger value="appearance">Font</TabsTrigger>
              <TabsTrigger value="editor">Editor</TabsTrigger>
            </TabsList>
            <TabsContent value="models">
              <ModelSettings active={settingsOpen} />
            </TabsContent>
            <TabsContent value="appearance">
              <FontSettings />
            </TabsContent>
            <TabsContent value="editor">
              <EditorSettings />
            </TabsContent>
            <TabsContent value="composer">
              <QuickCommandsSettings />
            </TabsContent>
            <TabsContent value="archived">
              <ArchivedChatsSettings
                sessions={archivedSessions}
                onUnarchive={onUnarchiveArchived}
                onDelete={onDeleteArchived}
              />
            </TabsContent>
            <TabsContent value="general">
              <PiAgentSettings
                active={settingsOpen}
                piVersion={appInfo?.piVersion}
                tuiOptimizationsEnabled={appInfo?.tuiOptimizationsEnabled}
                onUpdated={onAppInfoChange}
              />
              <CommonSettings defaultCwd={appInfo?.defaultCwd} onChanged={onAppInfoChange} />
            </TabsContent>
          </Tabs>
        </div>
      ) : null}
    </>
  );
}
