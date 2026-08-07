import { FolderOpen, RefreshCw } from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import type { PackageProgress, PackageRecord, PackageUpdateInfo, RemotePackageInfo } from "../../types/contracts";
import { ExplorePackagesPane, InstalledPackagesPane } from "./PackagePanes";

interface PackagePanelProps {
  open: boolean;
  cwd: string;
  onOpenChange: (open: boolean) => void;
  onReloadPi: () => Promise<void>;
}

export const PackagePanel = memo(function PackagePanel({ open, cwd, onOpenChange, onReloadPi }: PackagePanelProps) {
  const [tab, setTab] = useState<"installed" | "explore">("installed");
  const [packages, setPackages] = useState<PackageRecord[]>([]);
  const [updates, setUpdates] = useState<PackageUpdateInfo[]>([]);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<PackageProgress>();
  const [error, setError] = useState<string>();
  const [needsReload, setNeedsReload] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [remotePackages, setRemotePackages] = useState<RemotePackageInfo[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string>();

  const refreshUpdates = useCallback(
    (force = false) => {
      setCheckingUpdates(true);
      void window.ePi.packages
        .checkUpdates(cwd, force)
        .then(setUpdates)
        .catch(() => undefined)
        .finally(() => setCheckingUpdates(false));
    },
    [cwd],
  );

  useEffect(() => {
    if (!open) return;
    setError(undefined);
    void window.ePi.packages
      .list(cwd)
      .then(setPackages)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    refreshUpdates();
  }, [cwd, open, refreshUpdates]);

  useEffect(() => setNeedsReload(false), [cwd]);
  useEffect(() => window.ePi.packages.onProgress(setProgress), []);

  const run = async (action: () => Promise<PackageRecord[]>, successMessage?: string) => {
    setBusy(true);
    setError(undefined);
    try {
      setPackages(await action());
      setNeedsReload(true);
      refreshUpdates(true);
      if (successMessage) toast.success(successMessage);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
      setProgress(undefined);
    }
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSearching(true);
    setSearchError(undefined);
    const timeout = window.setTimeout(() => {
      void window.ePi.packages
        .search(searchQuery)
        .then((results) => {
          if (!cancelled) setRemotePackages(results);
        })
        .catch((reason: unknown) => {
          if (!cancelled) {
            setSearchError(reason instanceof Error ? reason.message : String(reason));
            setRemotePackages([]);
          }
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [open, searchQuery]);

  const reloadPi = async () => {
    await onReloadPi();
    setNeedsReload(false);
  };

  // Local packages are plain directories referenced from settings — pi does
  // not copy them, so installing one is just a directory pick plus a persist.
  const installLocal = async () => {
    const path = await window.ePi.app.chooseDirectory(cwd);
    if (!path) return;
    void run(() => window.ePi.packages.install({ source: path, cwd }), `${path.split("/").pop()} installed`);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="package-drawer" showCloseButton={false} aria-describedby="package-drawer-description">
        <SheetDescription id="package-drawer-description" className="sr-only">
          Install and manage Pi packages for the current workspace.
        </SheetDescription>
        <div className="package-panel-top">
          <Tabs
            className="package-drawer-tabs"
            value={tab}
            onValueChange={(value) => setTab(value as "installed" | "explore")}
            aria-label="Package panel"
          >
            <TabsList>
              <TabsTrigger value="installed">Installed</TabsTrigger>
              <TabsTrigger value="explore">Explore</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button
            variant="secondary"
            size="sm"
            onClick={installLocal}
            disabled={busy}
            title="Install a package from a local directory"
          >
            <FolderOpen size={13} />
            Install local…
          </Button>
        </div>
        <div className="package-panes">
          <div
            className={`package-pane${tab === "installed" ? "" : " package-pane-hidden"}`}
            aria-hidden={tab !== "installed"}
          >
            {error ? (
              <div className="inline-error" role="alert">
                {error}
              </div>
            ) : null}
            <InstalledPackagesPane
              packages={packages}
              updates={updates}
              checkingUpdates={checkingUpdates}
              onCheckUpdates={() => refreshUpdates(true)}
              cwd={cwd}
              busy={busy}
              progress={progress}
              run={(action, message) => void run(action, message)}
            />
          </div>
          <div
            className={`package-pane${tab === "explore" ? "" : " package-pane-hidden"}`}
            aria-hidden={tab !== "explore"}
          >
            <ExplorePackagesPane
              packages={packages}
              updates={updates}
              remotePackages={remotePackages}
              searchQuery={searchQuery}
              searching={searching}
              searchError={searchError}
              onSearchQueryChange={setSearchQuery}
              onInstalled={() => setTab("installed")}
              cwd={cwd}
              busy={busy}
              progress={progress}
              run={(action, message) => void run(action, message)}
            />
          </div>
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
});
