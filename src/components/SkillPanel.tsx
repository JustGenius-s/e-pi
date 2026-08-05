import { FolderOpen, FolderPlus, LoaderCircle, Plus, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import type { SkillRecord, SkillScope } from "../types/contracts";
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
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";
import { Sheet, SheetContent, SheetDescription } from "./ui/sheet";
import { Switch } from "./ui/switch";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { Textarea } from "./ui/textarea";

interface SkillPanelProps {
  open: boolean;
  cwd: string;
  onOpenChange: (open: boolean) => void;
  onReloadPi: () => Promise<void>;
}

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function sourceLabel(source: SkillRecord["source"]): string {
  return source === "project" ? "Project" : source === "user" ? "Global" : "Path";
}

export function SkillPanel({ open, cwd, onOpenChange, onReloadPi }: SkillPanelProps) {
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [needsReload, setNeedsReload] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newScope, setNewScope] = useState<SkillScope>("project");
  const [removeTarget, setRemoveTarget] = useState<SkillRecord>();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setSkills(await window.ePi.skills.list(cwd));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    if (!open) return;
    setError(undefined);
    void refresh();
  }, [cwd, open, refresh]);

  useEffect(() => {
    setNeedsReload(false);
  }, [cwd]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return skills;
    return skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(normalized));
  }, [query, skills]);

  const validName = SKILL_NAME_PATTERN.test(newName.trim());

  const run = async (action: () => Promise<SkillRecord[]>, successMessage?: string) => {
    setBusy(true);
    setError(undefined);
    try {
      setSkills(await action());
      setNeedsReload(true);
      if (successMessage) toast.success(successMessage);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = (skill: SkillRecord, enabled: boolean) =>
    run(() => window.ePi.skills.setEnabled({ cwd, filePath: skill.filePath, enabled }));

  const remove = async () => {
    if (!removeTarget) return;
    await run(() => window.ePi.skills.remove({ cwd, filePath: removeTarget.filePath }), `${removeTarget.name} deleted`);
    setRemoveTarget(undefined);
  };

  const addPath = async (scope: SkillScope) => {
    const path = await window.ePi.app.chooseDirectory(cwd);
    if (!path) return;
    await run(() => window.ePi.skills.addPath({ cwd, scope, path }), "Skill path added");
  };

  const create = async () => {
    await run(
      () =>
        window.ePi.skills.create({
          cwd,
          scope: newScope,
          name: newName.trim(),
          description: newDescription.trim(),
        }),
      `${newName.trim()} created`,
    );
    setCreateOpen(false);
    setNewName("");
    setNewDescription("");
  };

  const reloadPi = async () => {
    await onReloadPi();
    setNeedsReload(false);
    toast.success("Pi reloaded");
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="skill-drawer" showCloseButton={false} aria-describedby="skill-drawer-description">
        <SheetDescription id="skill-drawer-description" className="sr-only">
          View and manage Pi skills for the current workspace.
        </SheetDescription>

        <section className="skill-install-section" aria-label="Skill actions">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" disabled={busy}>
                <Plus size={14} />
                New
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-52">
              <DropdownMenuItem onSelect={() => setCreateOpen(true)}>
                <FolderPlus size={14} />
                Create a skill
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void addPath("project")}>
                <FolderOpen size={14} />
                Add project path…
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void addPath("user")}>
                <FolderOpen size={14} />
                Add global path…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <label className="skill-search">
            <Search size={14} />
            <span className="sr-only">Search skills</span>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search skills"
              type="search"
            />
          </label>
        </section>

        <div className="skill-drawer-body">
          {error ? (
            <div className="inline-error" role="alert">
              {error}
            </div>
          ) : null}

          <section className="skill-list-section" aria-live="polite">
            <div className="section-heading-row">
              <h3>
                Skills <span>{skills.length}</span>
              </h3>
            </div>

            {loading && skills.length === 0 ? (
              <div className="skill-panel-empty">
                <LoaderCircle className="spin" size={15} /> Loading skills
              </div>
            ) : filtered.length === 0 ? (
              <div className="skill-panel-empty">No skills found</div>
            ) : (
              <ScrollArea className="skill-panel-list" type="auto">
                {filtered.map((skill) => (
                  <div className="skill-panel-item" key={skill.filePath}>
                    <div className="skill-panel-row">
                      <div className="skill-panel-info" title={skill.description || skill.baseDir}>
                        <span className="skill-panel-name" data-disabled={!skill.enabled}>
                          {skill.name}
                        </span>
                        <span className="skill-panel-meta">
                          <Badge variant="outline">{sourceLabel(skill.source)}</Badge>
                        </span>
                      </div>
                      <Switch
                        size="sm"
                        checked={skill.enabled}
                        disabled={busy}
                        onCheckedChange={(enabled) => void setEnabled(skill, enabled)}
                        aria-label={`Toggle ${skill.name}`}
                      />
                    </div>
                  </div>
                ))}
              </ScrollArea>
            )}
          </section>
        </div>

        {needsReload ? (
          <div className="drawer-footer-note">
            <span>Reload Pi to apply changes.</span>
            <Button variant="secondary" size="sm" onClick={() => void reloadPi()} disabled={busy}>
              <RefreshCw size={13} />
              Reload Pi
            </Button>
          </div>
        ) : null}

        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create a skill</DialogTitle>
              <DialogDescription>A new skill directory with a SKILL.md will be created.</DialogDescription>
            </DialogHeader>
            <div className="skill-create-form">
              <Tabs
                value={newScope}
                onValueChange={(value) => setNewScope(value as SkillScope)}
                aria-label="Skill scope"
              >
                <TabsList>
                  <TabsTrigger value="project">Project</TabsTrigger>
                  <TabsTrigger value="user">Global</TabsTrigger>
                </TabsList>
              </Tabs>
              <label>
                <span>Name</span>
                <Input
                  autoFocus
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder="my-skill"
                  aria-invalid={newName.length > 0 && !validName}
                />
                {newName.length > 0 && !validName ? <small>Lowercase letters, numbers, and hyphens only.</small> : null}
              </label>
              <label>
                <span>Description</span>
                <Textarea
                  value={newDescription}
                  onChange={(event) => setNewDescription(event.target.value)}
                  placeholder="What this skill does and when to use it."
                  rows={3}
                />
              </label>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button onClick={() => void create()} disabled={!validName || !newDescription.trim() || busy}>
                Create skill
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <AlertDialog open={Boolean(removeTarget)} onOpenChange={(next) => !next && setRemoveTarget(undefined)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete skill?</AlertDialogTitle>
              <AlertDialogDescription>
                {removeTarget?.name} will be moved to the system Trash
                {removeTarget && !removeTarget.managed
                  ? " and removed from the configured skill paths. Files outside this project are deleted at your own risk."
                  : ""}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void remove()}>Move to Trash</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  );
}
