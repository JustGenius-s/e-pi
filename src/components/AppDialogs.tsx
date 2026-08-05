import { useRef } from "react";

import { sessionTitle } from "../lib/format";
import type { AppInfo, SessionSummary } from "../types/contracts";
import { FontSettings } from "./FontSettings";
import { ModelSettings } from "./ModelSettings";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

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
  const composingRef = useRef(false);
  return (
    <Input
      autoFocus
      value={value}
      aria-label="Session name"
      onChange={(event) => onChange(event.target.value)}
      onCompositionStart={() => {
        composingRef.current = true;
      }}
      onCompositionEnd={() => {
        window.setTimeout(() => {
          composingRef.current = false;
        }, 0);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        if (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
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
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
  appInfo?: AppInfo;
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
  settingsOpen,
  onSettingsOpenChange,
  appInfo,
}: AppDialogsProps) {
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
              {removeTarget ? sessionTitle(removeTarget) : "This session"} will be moved to the system Trash.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmRemove}>Archive</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={settingsOpen}
        onOpenChange={(open) => {
          if (!open) window.ePi.models.cancelLogin();
          onSettingsOpenChange(open);
        }}
      >
        <DialogContent className="settings-dialog">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription>Manage models and application details.</DialogDescription>
          </DialogHeader>
          <Tabs className="settings-tabs" defaultValue="models">
            <TabsList variant="line">
              <TabsTrigger value="models">Models</TabsTrigger>
              <TabsTrigger value="general">General</TabsTrigger>
              <TabsTrigger value="appearance">Font</TabsTrigger>
            </TabsList>
            <TabsContent value="models">
              <ModelSettings active={settingsOpen} />
            </TabsContent>
            <TabsContent value="appearance">
              <FontSettings />
            </TabsContent>
            <TabsContent value="general">
              <div className="settings-summary">
                <div>
                  <span>Pi version</span>
                  <strong>{appInfo?.piVersion || "-"}</strong>
                </div>
                <div>
                  <span>Default folder</span>
                  <strong title={appInfo?.defaultCwd}>{appInfo?.defaultCwd || "-"}</strong>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
    </>
  );
}
