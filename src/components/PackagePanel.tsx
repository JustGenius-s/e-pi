import { Check, Package, RefreshCw, Search, Trash2 } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import type { PackageProgress, PackageRecord, PackageUpdateInfo, RemotePackageInfo } from "../types/contracts";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Sheet, SheetContent, SheetDescription } from "./ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

interface PackagePanelProps {
  open: boolean;
  cwd: string;
  onOpenChange: (open: boolean) => void;
  onReloadPi: () => Promise<void>;
}

/**
 * Memoized: re-renders of App (e.g. per-session runtime state updates) must
 * not disturb the panel's Tabs/Select/AlertDialog focus and open states.
 */
export const PackagePanel = memo(function PackagePanel({ open, cwd, onOpenChange, onReloadPi }: PackagePanelProps) {
  const [tab, setTab] = useState<"installed" | "browse">("installed");
  const [packages, setPackages] = useState<PackageRecord[]>([]);
  const [updates, setUpdates] = useState<PackageUpdateInfo[]>([]);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [scope, setScope] = useState<"user" | "project">("user");
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
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    refreshUpdates();
  }, [cwd, open, refreshUpdates]);

  useEffect(() => {
    setNeedsReload(false);
  }, [cwd]);

  useEffect(() => window.ePi.packages.onProgress(setProgress), []);

  const run = async (action: () => Promise<PackageRecord[]>) => {
    setBusy(true);
    setError(undefined);
    try {
      setPackages(await action());
      setNeedsReload(true);
      // Mutations invalidate the cached update results.
      refreshUpdates(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      setProgress(undefined);
    }
  };

  const switchTab = (value: "installed" | "browse") => {
    setTab(value);
  };

  const installRemote = (name: string) => {
    void run(async () => {
      const result = await window.ePi.packages.install({ source: `npm:${name}`, cwd, scope });
      setTab("installed");
      return result;
    });
  };

  // Packages already installed in this workspace (any scope), matched by
  // bare npm name so `npm:@scope/name` and `@scope/name` both line up.
  const installedNames = useMemo(() => new Set(packages.map((item) => item.source.replace(/^npm:/, ""))), [packages]);

  // Debounced registry search while the panel is open. Runs on open and on
  // query change only — the active tab never re-triggers network work, so
  // switching stays instant. Stale responses are dropped.
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
          if (cancelled) return;
          setSearchError(reason instanceof Error ? reason.message : String(reason));
          setRemotePackages([]);
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
            onValueChange={(value) => switchTab(value as "installed" | "browse")}
            aria-label="Package panel"
          >
            <TabsList>
              <TabsTrigger value="installed" onClick={() => switchTab("installed")}>
                Installed
              </TabsTrigger>
              <TabsTrigger value="browse" onClick={() => switchTab("browse")}>
                Browse
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Select value={scope} onValueChange={(value) => setScope(value as "user" | "project")}>
            <SelectTrigger className="package-scope-select" aria-label="Install scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="user">Global</SelectItem>
              <SelectItem value="project">Project</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="package-panes">
          <div
            className={`package-pane${tab === "installed" ? "" : " package-pane-hidden"}`}
            aria-hidden={tab !== "installed"}
          >
            <div className="package-drawer-body">
              {error ? (
                <div className="inline-error" role="alert">
                  {error}
                </div>
              ) : null}

              <section className="package-list-section" aria-live="polite">
                <div className="section-heading-row">
                  <h3>
                    Installed <span>{packages.length}</span>
                  </h3>
                  <div className="section-heading-actions">
                    <IconButton
                      label="Check for updates"
                      onClick={() => refreshUpdates(true)}
                      disabled={busy || checkingUpdates || packages.length === 0}
                    >
                      <RefreshCw size={14} className={checkingUpdates ? "package-spin" : undefined} />
                    </IconButton>
                    <IconButton
                      label="Update all packages"
                      onClick={() => void run(() => window.ePi.packages.update({ cwd }))}
                      disabled={busy || packages.length === 0}
                    >
                      <Package size={14} />
                    </IconButton>
                  </div>
                </div>

                {busy && progress ? (
                  <div className="progress-line">
                    <span />
                    {progress.message || `${progress.action} ${progress.source}`}
                  </div>
                ) : null}

                {packages.length === 0 && !busy ? (
                  <div className="package-empty">No packages installed</div>
                ) : (
                  <div className="package-list">
                    {packages.map((item) => {
                      const updateInfo = updates.find(
                        (candidate) => candidate.source === item.source && candidate.scope === item.scope,
                      );
                      return (
                        <div className="package-row" key={`${item.scope}:${item.source}`}>
                          <div className="package-row-main">
                            <strong title={item.source}>{item.source}</strong>
                            <span>
                              {item.version ? `v${item.version}` : "version unknown"}
                              {" · "}
                              {item.scope === "project" ? "Project" : "Global"}
                              {item.filtered ? " · Filtered" : ""}
                            </span>
                          </div>
                          <div className="package-row-side">
                            {updateInfo ? (
                              <span
                                className="package-update-badge"
                                title={`Update available${updateInfo.latestVersion ? `: v${updateInfo.latestVersion}` : ""}`}
                              >
                                ↑ {updateInfo.latestVersion ? `v${updateInfo.latestVersion}` : "Update"}
                              </span>
                            ) : null}
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
                                      {item.source} will be removed from the{" "}
                                      {item.scope === "project" ? "project" : "global"} package list.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction
                                      onClick={() =>
                                        void run(() =>
                                          window.ePi.packages.remove({
                                            source: item.source,
                                            cwd,
                                            scope: item.scope,
                                          }),
                                        )
                                      }
                                    >
                                      Remove
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
          </div>
          <div
            className={`package-pane${tab === "browse" ? "" : " package-pane-hidden"}`}
            aria-hidden={tab !== "browse"}
          >
            <div className="package-drawer-body">
              <section className="package-browse-section" aria-label="Browse packages">
                <div className="package-search-box">
                  <Search size={13} />
                  <Input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    aria-label="Search packages"
                    placeholder="Search Pi packages on npm…"
                  />
                  {searching ? <span className="package-search-spinner" /> : null}
                </div>
              </section>

              {searchError ? (
                <div className="inline-error" role="alert">
                  {searchError}
                </div>
              ) : null}

              <section className="package-list-section" aria-live="polite">
                <div className="section-heading-row">
                  <h3>
                    Results <span>{remotePackages.length}</span>
                  </h3>
                </div>
                {!searching && remotePackages.length === 0 ? (
                  <div className="package-empty">
                    {searchQuery.trim() ? "No packages found" : "Search for Pi packages published on npm"}
                  </div>
                ) : (
                  <div className="package-list">
                    {remotePackages.map((pkg) => {
                      const installed = installedNames.has(pkg.name);
                      return (
                        <div className="package-row package-remote-row" key={pkg.name}>
                          <div className="package-row-main">
                            <strong title={pkg.name}>{pkg.name}</strong>
                            <span className="package-remote-desc" title={pkg.description}>
                              {pkg.description}
                            </span>
                            {pkg.author || pkg.date ? (
                              <span className="package-remote-meta">
                                {pkg.author ? `${pkg.author} · ` : ""}
                                {pkg.date ? `${new Date(pkg.date).toLocaleDateString()} · ` : ""}v{pkg.version}
                              </span>
                            ) : null}
                          </div>
                          <div className="package-row-side">
                            <Button
                              size="sm"
                              variant={installed ? "secondary" : "outline"}
                              onClick={() => installRemote(pkg.name)}
                              disabled={busy || installed}
                            >
                              {installed ? <Check size={13} /> : <Package size={13} />}
                              {installed ? "Installed" : "Install"}
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
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
