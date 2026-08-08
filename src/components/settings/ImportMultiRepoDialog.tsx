import { Folder, FolderGit2, Star, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/input";

import { compactPath, pathBaseName } from "../../lib/format";
import type { Project } from "../../types/contracts";

interface ImportMultiRepoDialogProps {
  open: boolean;
  defaultPath?: string;
  onOpenChange: (open: boolean) => void;
  /** Existing project to edit; undefined creates a new one. */
  editing?: Project;
  /** Pre-filled folders for creating a project (promoting an existing folder group). */
  initial?: { folders: string[]; primaryRepo: string };
  /** Resolves with the created project; the caller then creates the session. */
  onCreateProject: (request: { name?: string; folders: string[]; primaryRepo: string }) => Promise<void>;
  /** Persist edits to an existing project. */
  onUpdateProject?: (id: string, request: { name?: string; folders: string[]; primaryRepo: string }) => Promise<void>;
}

/**
 * "Import multi-repo project": pick several source folders/repos and declare
 * one of them the primary repo (git/agent target). Only writes the project;
 * the caller creates the first session inside the primary repo.
 */
export function ImportMultiRepoDialog({
  open,
  defaultPath,
  onOpenChange,
  editing,
  initial,
  onCreateProject,
  onUpdateProject,
}: ImportMultiRepoDialogProps) {
  const [name, setName] = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  const [primary, setPrimary] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const suggestedName = useMemo(() => (folders[0] ? pathBaseName(folders[0]) : ""), [folders]);
  // The name field is user-editable; only auto-fill it when it is still empty
  // or still matches the previous suggestion.
  const [autoNamed, setAutoNamed] = useState(true);

  // Reset the draft whenever the dialog opens (or the target project changes).
  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? (initial ? pathBaseName(initial.primaryRepo) : ""));
    setFolders(editing?.folders ?? initial?.folders ?? []);
    setPrimary(editing?.primaryRepo ?? initial?.primaryRepo);
    setAutoNamed(!editing);
    setError(undefined);
    setBusy(false);
  }, [open, editing, initial]);

  const addFolders = async (): Promise<void> => {
    const picked = await window.ePi.app.chooseDirectories(defaultPath);
    if (picked.length === 0) return;
    const merged = [...folders];
    for (const folder of picked) {
      if (!merged.includes(folder)) merged.push(folder);
    }
    setFolders(merged);
    setPrimary((current) => current ?? merged[0]);
    if (autoNamed) setName(pathBaseName(merged[0]));
  };

  const removeFolder = (folder: string): void => {
    const next = folders.filter((candidate) => candidate !== folder);
    setFolders(next);
    setPrimary((current) => (current === folder ? next[0] : current));
  };

  const setAsPrimary = (folder: string): void => {
    setPrimary(folder);
    if (autoNamed) setName(pathBaseName(folder));
  };

  const canCreate = folders.length > 0 && primary !== undefined && !busy;

  const submit = async (): Promise<void> => {
    if (!canCreate) return;
    setBusy(true);
    setError(undefined);
    try {
      const request = { name: name.trim() || undefined, folders, primaryRepo: primary! };
      if (editing && onUpdateProject) await onUpdateProject(editing.id, request);
      else await onCreateProject(request);
      onOpenChange(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="custom-provider-dialog import-repo-dialog">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit workspace" : "Add workspace"}</DialogTitle>
        </DialogHeader>
        <div className="import-repo-form">
          <label className="custom-field">
            <span>Workspace name</span>
            <Input
              value={name}
              placeholder={suggestedName || "Workspace name"}
              onChange={(event) => {
                setName(event.target.value);
                setAutoNamed(false);
              }}
            />
          </label>

          <section className="import-repo-folders">
            <span className="import-repo-folders-label">Source folders / repos</span>
            {folders.length === 0 ? (
              <div className="import-repo-empty">No folders yet — add at least one.</div>
            ) : (
              <ul className="import-repo-list">
                {folders.map((folder) => {
                  const isPrimary = folder === primary;
                  return (
                    <li key={folder} className={`import-repo-row${isPrimary ? " is-primary" : ""}`}>
                      <FolderGit2 size={15} className="import-repo-row-icon" aria-hidden="true" />
                      <span className="import-repo-row-path" title={folder}>
                        {compactPath(folder, 62)}
                      </span>
                      {isPrimary ? (
                        <span className="import-repo-primary-badge">Primary</span>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="import-repo-set-primary"
                          onClick={() => setAsPrimary(folder)}
                          title="Set as primary repo"
                        >
                          <Star size={13} />
                          <span>Set primary</span>
                        </Button>
                      )}
                      <IconButton label={`Remove ${folder}`} onClick={() => removeFolder(folder)}>
                        <X size={13} />
                      </IconButton>
                    </li>
                  );
                })}
              </ul>
            )}
            <Button variant="outline" size="sm" className="import-repo-add" onClick={() => void addFolders()}>
              <Folder size={14} />
              <span>Add folders</span>
            </Button>
          </section>

          {error ? <div className="runtime-error import-repo-error">{error}</div> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canCreate}>
            {editing ? "Save changes" : "Create workspace"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
