import { ArchiveRestore, Trash2 } from "lucide-react";
import { useState } from "react";

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

import { pathBaseName, relativeTime, sessionTitle } from "../../lib/format";
import type { ArchivedSessionSummary } from "../../types/contracts";

interface ArchivedChatsSettingsProps {
  sessions: ArchivedSessionSummary[];
  onUnarchive: (session: ArchivedSessionSummary) => void;
  onDelete: (session: ArchivedSessionSummary) => void;
}

/**
 * Settings → Archived: the Codex-style archive area. Chats archived from
 * the sidebar land here (their files moved out of pi's session tree);
 * Unarchive moves a chat straight back to its original project, and Delete
 * is the only permanent-delete entry point (system Trash as a last resort).
 */
export function ArchivedChatsSettings({ sessions, onUnarchive, onDelete }: ArchivedChatsSettingsProps) {
  const [deleteTarget, setDeleteTarget] = useState<ArchivedSessionSummary>();

  return (
    <div className="archived-section">
      <div className="agent-group-title">Archived chats</div>
      <p className="agent-description">
        Archived chats are hidden from the sidebar but stay on disk. Unarchive brings a chat back to its project;
        deleting moves it to the system Trash.
      </p>
      {sessions.length === 0 ? (
        <div className="model-settings-empty">No archived chats.</div>
      ) : (
        <ul className="archived-list">
          {sessions.map((session) => (
            <li key={session.path} className="archived-row">
              <div className="archived-row-main">
                <span className="archived-row-title" title={session.path}>
                  {sessionTitle(session)}
                </span>
                <span className="archived-row-meta">
                  {pathBaseName(session.cwd) || "Unknown folder"} · {session.messageCount} message
                  {session.messageCount === 1 ? "" : "s"} · archived {relativeTime(session.archivedAt)}
                </span>
              </div>
              <div className="archived-row-actions">
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => onUnarchive(session)}
                  title={`Restore to ${session.cwd}`}
                >
                  <ArchiveRestore size={13} />
                  <span>Unarchive</span>
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Delete archived chat"
                  title="Delete forever"
                  onClick={() => setDeleteTarget(session)}
                >
                  <Trash2 size={13} />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete archived chat?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget ? sessionTitle(deleteTarget) : "This session"} will be moved to the system Trash. This is
              permanent — E-Pi can no longer restore it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteTarget) onDelete(deleteTarget);
                setDeleteTarget(undefined);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
