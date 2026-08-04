import { Package, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { PackageProgress, PackageRecord } from "../types/contracts";
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
  AlertDialogTrigger,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Sheet, SheetContent, SheetDescription } from "./ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

interface PackagePanelProps {
  open: boolean;
  cwd: string;
  onOpenChange: (open: boolean) => void;
  onReloadPi: () => Promise<void>;
}

export function PackagePanel({ open, cwd, onOpenChange, onReloadPi }: PackagePanelProps) {
  const [packages, setPackages] = useState<PackageRecord[]>([]);
  const [source, setSource] = useState("");
  const [scope, setScope] = useState<"user" | "project">("user");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<PackageProgress>();
  const [error, setError] = useState<string>();
  const [needsReload, setNeedsReload] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(undefined);
    void window.ePi.packages.list(cwd).then(setPackages).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [cwd, open]);

  useEffect(() => {
    setNeedsReload(false);
  }, [cwd]);

  useEffect(() => window.ePi.packages.onProgress(setProgress), []);

  const run = async (action: () => Promise<PackageRecord[]>, clearSource = false) => {
    setBusy(true);
    setError(undefined);
    try {
      setPackages(await action());
      if (clearSource) setSource("");
      setNeedsReload(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      setProgress(undefined);
    }
  };

  const install = () => {
    const value = source.trim();
    if (!value) return;
    void run(() => window.ePi.packages.install({ source: value, cwd, scope }), true);
  };

  const reloadPi = async () => {
    await onReloadPi();
    setNeedsReload(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="package-drawer" aria-describedby="package-drawer-description">
        <SheetDescription id="package-drawer-description" className="sr-only">
          Install and manage Pi packages for the current workspace.
        </SheetDescription>

        <section className="package-install-section" aria-label="Install package">
          <Tabs value={scope} onValueChange={(value) => setScope(value as "user" | "project")} aria-label="Install scope">
            <TabsList>
              <TabsTrigger value="user">Global</TabsTrigger>
              <TabsTrigger value="project">Project</TabsTrigger>
            </TabsList>
          </Tabs>
          <Input
            id="package-source"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") install();
            }}
            aria-label="Package source"
            placeholder="Package, Git URL, or local path"
            disabled={busy}
          />
          <Button size="sm" onClick={install} disabled={!source.trim() || busy}>
            <Package size={14} />
            Install
          </Button>
        </section>

        <div className="package-drawer-body">
          {error ? <div className="inline-error" role="alert">{error}</div> : null}

          <section className="package-list-section" aria-live="polite">
            <div className="section-heading-row">
              <h3>Installed <span>{packages.length}</span></h3>
              <IconButton
                label="Update all packages"
                onClick={() => void run(() => window.ePi.packages.update({ cwd }))}
                disabled={busy || packages.length === 0}
              >
                <RefreshCw size={14} />
              </IconButton>
            </div>

            {busy && progress ? (
              <div className="progress-line"><span />{progress.message || `${progress.action} ${progress.source}`}</div>
            ) : null}

            {packages.length === 0 && !busy ? (
              <div className="package-empty">No packages installed</div>
            ) : (
              <div className="package-list">
                {packages.map((item) => (
                  <div className="package-row" key={`${item.scope}:${item.source}`}>
                    <div className="package-row-main">
                      <strong title={item.source}>{item.source}</strong>
                      <span>{item.scope === "project" ? "Project" : "Global"}{item.filtered ? " · Filtered" : ""}</span>
                    </div>
                    <div className="package-row-actions">
                      <IconButton
                        label={`Update ${item.source}`}
                        onClick={() => void run(() => window.ePi.packages.update({ cwd, source: item.source }))}
                        disabled={busy}
                      >
                        <RefreshCw size={14} />
                      </IconButton>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <IconButton label={`Remove ${item.source}`} disabled={busy}>
                            <Trash2 size={14} />
                          </IconButton>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Remove package?</AlertDialogTitle>
                            <AlertDialogDescription>
                              {item.source} will be removed from the {item.scope === "project" ? "project" : "global"} package list.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => void run(() => window.ePi.packages.remove({ source: item.source, cwd, scope: item.scope }))}>
                              Remove
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </div>
                ))}
              </div>
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
      </SheetContent>
    </Sheet>
  );
}
