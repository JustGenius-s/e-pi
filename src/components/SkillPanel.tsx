import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderOpen, FolderPlus, LoaderCircle, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import type { SkillRecord, SkillScope } from "../types/contracts";
import { IconButton } from "./IconButton";
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
  const [selectedPath, setSelectedPath] = useState<string>();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<string>();
  const [needsReload, setNeedsReload] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newScope, setNewScope] = useState<SkillScope>("project");
  const [removeTarget, setRemoveTarget] = useState<SkillRecord>();

  const refresh = useCallback(async (opts?: { keepSelection?: boolean }) => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await window.ePi.skills.list(cwd);
      setSkills(next);
      if (!opts?.keepSelection) {
        setSelectedPath((current) =>
          current && next.some((skill) => skill.filePath === current) ? current : next[0]?.filePath);
      }
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

  useEffect(() => {
    if (!open || !selectedPath) {
      setPreview(undefined);
      return;
    }
    let mounted = true;
    window.ePi.skills.read(cwd, selectedPath)
      .then((content) => {
        if (mounted) setPreview(content);
      })
      .catch(() => {
        if (mounted) setPreview(undefined);
      });
    return () => {
      mounted = false;
    };
  }, [cwd, open, selectedPath]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return skills;
    return skills.filter((skill) =>
      `${skill.name} ${skill.description}`.toLowerCase().includes(normalized));
  }, [query, skills]);

  const validName = SKILL_NAME_PATTERN.test(newName.trim());

  const run = async (action: () => Promise<SkillRecord[]>) => {
    setBusy(true);
    setError(undefined);
    try {
      setSkills(await action());
      setNeedsReload(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = (skill: SkillRecord, enabled: boolean) =>
    run(() => window.ePi.skills.setEnabled({ cwd, filePath: skill.filePath, enabled }));

  const remove = async () => {
    if (!removeTarget) return;
    await run(() => window.ePi.skills.remove({ cwd, filePath: removeTarget.filePath }));
    setRemoveTarget(undefined);
  };

  const addPath = async (scope: SkillScope) => {
    const path = await window.ePi.app.chooseDirectory(cwd);
    if (!path) return;
    await run(() => window.ePi.skills.addPath({ cwd, scope, path }));
  };

  const create = async () => {
    await run(() => window.ePi.skills.create({
      cwd,
      scope: newScope,
      name: newName.trim(),
      description: newDescription.trim(),
    }));
    setCreateOpen(false);
    setNewName("");
    setNewDescription("");
  };

  const reloadPi = async () => {
    await onReloadPi();
    setNeedsReload(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="skill-drawer" aria-describedby="skill-drawer-description">
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
          {error ? <div className="inline-error" role="alert">{error}</div> : null}

          <section className="skill-list-section" aria-live="polite">
            <div className="section-heading-row">
              <h3>Skills <span>{skills.length}</span></h3>
              <IconButton
                label="Refresh skills"
                onClick={() => void refresh({ keepSelection: true })}
                disabled={busy}
              >
                <RefreshCw size={14} />
              </IconButton>
            </div>

            {loading && skills.length === 0 ? (
              <div className="skill-panel-empty"><LoaderCircle className="spin" size={15} /> Loading skills</div>
            ) : filtered.length === 0 ? (
              <div className="skill-panel-empty">No skills found</div>
            ) : (
              <ScrollArea className="skill-panel-list" type="auto">
                {filtered.map((skill) => (
                  <div
                    className="skill-panel-item"
                    data-active={skill.filePath === selectedPath}
                    key={skill.filePath}
                  >
                    <button
                      className="skill-panel-select"
                      onClick={() => setSelectedPath(skill.filePath)}
                      type="button"
                      title={skill.description || skill.baseDir}
                    >
                      <span className="skill-panel-name" data-disabled={!skill.enabled}>{skill.name}</span>
                      <span className="skill-panel-meta">
                        <Badge variant="outline">{sourceLabel(skill.source)}</Badge>
                        <span className={`skill-row-dot ${skill.enabled ? "is-on" : ""}`} aria-label={skill.enabled ? "Enabled" : "Disabled"} />
                      </span>
                    </button>

                    {skill.filePath === selectedPath ? (
                      <div className="skill-panel-detail">
                        {skill.description ? <p className="skill-description">{skill.description}</p> : null}

                        <div className="skill-status">
                          <span className="skill-status-label">Enabled</span>
                          <div className="skill-status-control">
                            <Switch
                              size="sm"
                              checked={skill.enabled}
                              disabled={busy}
                              onCheckedChange={(enabled) => void setEnabled(skill, enabled)}
                              aria-label={`Toggle ${skill.name}`}
                            />
                            <span className="skill-status-hint">
                              {skill.enabled
                                ? "Pi can load this skill when a task matches."
                                : "Disabled — Pi will not auto-invoke it. Use /skill:name to run it manually."}
                            </span>
                          </div>
                        </div>

                        <div className="skill-path" title={skill.baseDir}>
                          <span>{skill.baseDir}</span>
                        </div>

                        <div className="skill-panel-actions">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void window.ePi.app.openPath(skill.baseDir)}
                            disabled={busy}
                          >
                            <FolderOpen size={14} />
                            Show in Finder
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-destructive"
                            onClick={() => setRemoveTarget(skill)}
                            disabled={busy}
                          >
                            <Trash2 size={14} />
                            Delete
                          </Button>
                        </div>

                        <div className="skill-preview-heading">
                          <span>SKILL.md</span>
                        </div>
                        <ScrollArea className="skill-preview" type="auto">
                          <pre>{preview ?? "Loading…"}</pre>
                        </ScrollArea>
                      </div>
                    ) : null}
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
              <DialogDescription>
                A new skill directory with a SKILL.md will be created.
              </DialogDescription>
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
                {newName.length > 0 && !validName ? (
                  <small>Lowercase letters, numbers, and hyphens only.</small>
                ) : null}
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
              <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
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
