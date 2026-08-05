import {
  ArrowBigUpDash,
  CloudSync,
  Package,
  PackageCheck,
  PackagePlus,
  PackageX,
  RefreshCw,
  Search,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import type {
  PackageDownloads,
  PackageProgress,
  PackageRecord,
  PackageUpdateInfo,
  RemotePackageInfo,
} from "../types/contracts";
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
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card";
import { Input } from "./ui/input";
import { Sheet, SheetContent, SheetDescription } from "./ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

/**
 * Map a configured source to the package's public website, when one is known:
 * npm sources resolve to the npm registry page, GitHub sources to the repo.
 */
function packageHomeUrl(source: string): string | undefined {
  const trimmed = source.trim();
  if (trimmed.startsWith("npm:")) {
    const name = trimmed
      .slice(4)
      .replace(/@[^/]+$/, "")
      .trim();
    return name ? `https://www.npmjs.com/package/${name}` : undefined;
  }
  if (trimmed.startsWith("github:")) {
    const slug = trimmed.slice("github:".length).replace(/\.git$/, "");
    return slug ? `https://github.com/${slug}` : undefined;
  }
  const github = trimmed.match(/github\.com[/:]([^/\s#?]+)\/([^/\s#?]+)/);
  if (github) return `https://github.com/${github[1]}/${github[2]}`;
  return undefined;
}

/** Renderer-side cache so repeated hovers don't re-ask the main process. */
const downloadsCache = new Map<string, PackageDownloads>();

function formatDownloads(count: number): string {
  if (count >= 1_000_000) {
    const millions = count / 1_000_000;
    return `${millions >= 100 ? Math.round(millions) : millions.toFixed(1)}M`;
  }
  if (count >= 1_000) {
    const thousands = count / 1_000;
    return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1)}k`;
  }
  return String(count);
}

function usePackageDownloads(name: string | undefined) {
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; downloads?: PackageDownloads }>({
    status: "loading",
  });
  useEffect(() => {
    if (!name) {
      setState({ status: "error" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    const cached = downloadsCache.get(name);
    if (cached) {
      setState({ status: "ready", downloads: cached });
      return;
    }
    window.ePi.packages
      .downloads(name)
      .then((result) => {
        downloadsCache.set(name, result);
        if (!cancelled) setState({ status: "ready", downloads: result });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [name]);
  return state;
}

/** Last-month npm download count, fetched lazily when a card opens. */
function DownloadsStat({ name }: { name: string | undefined }) {
  const { status, downloads } = usePackageDownloads(name);
  return (
    <dd className="package-hover-downloads">
      {status === "ready" && downloads ? formatDownloads(downloads.downloads) : status === "error" ? "—" : "…"}
    </dd>
  );
}

function InstalledPackageCard({ item, updateInfo }: { item: PackageRecord; updateInfo?: PackageUpdateInfo }) {
  const npmName = item.source.startsWith("npm:") ? item.source.slice(4) : undefined;
  const homeUrl = packageHomeUrl(item.source);
  return (
    <div className="package-hover-card-inner">
      <div className="package-hover-card-head">
        <strong title={item.source}>{item.source}</strong>
        {item.version ? <span>v{item.version}</span> : null}
      </div>
      <dl className="package-hover-stats">
        <div>
          <dt>Downloads / mo</dt>
          <DownloadsStat name={npmName} />
        </div>
        {updateInfo ? (
          <div>
            <dt>Latest</dt>
            <dd>{updateInfo.latestVersion ? `v${updateInfo.latestVersion}` : "Update available"}</dd>
          </div>
        ) : null}
        {item.filtered ? (
          <div>
            <dt>Config</dt>
            <dd>Filtered (autoload delta)</dd>
          </div>
        ) : null}
      </dl>
      {homeUrl ? (
        <a className="package-hover-link" href={homeUrl} target="_blank" rel="noreferrer">
          Open website ↗
        </a>
      ) : null}
    </div>
  );
}

function ExplorePackageCard({ pkg }: { pkg: RemotePackageInfo }) {
  return (
    <div className="package-hover-card-inner">
      <div className="package-hover-card-head">
        <strong title={pkg.name}>{pkg.name}</strong>
        <span>v{pkg.version}</span>
      </div>
      {pkg.description ? <p className="package-hover-desc">{pkg.description}</p> : null}
      <dl className="package-hover-stats">
        <div>
          <dt>Downloads / mo</dt>
          <DownloadsStat name={pkg.name} />
        </div>
        {pkg.author ? (
          <div>
            <dt>Author</dt>
            <dd title={pkg.author}>{pkg.author}</dd>
          </div>
        ) : null}
        {pkg.date ? (
          <div>
            <dt>Published</dt>
            <dd>{new Date(pkg.date).toLocaleDateString()}</dd>
          </div>
        ) : null}
        {pkg.popularity != null ? (
          <div>
            <dt>Popularity</dt>
            <dd>{(pkg.popularity * 100).toFixed(0)}%</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

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
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    refreshUpdates();
  }, [cwd, open, refreshUpdates]);

  useEffect(() => {
    setNeedsReload(false);
  }, [cwd]);

  useEffect(() => window.ePi.packages.onProgress(setProgress), []);

  const run = async (action: () => Promise<PackageRecord[]>, successMessage?: string) => {
    setBusy(true);
    setError(undefined);
    try {
      setPackages(await action());
      setNeedsReload(true);
      // Mutations invalidate the cached update results.
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

  const switchTab = (value: "installed" | "explore") => {
    setTab(value);
  };

  const installRemote = (name: string) => {
    void run(async () => {
      const result = await window.ePi.packages.install({ source: `npm:${name}`, cwd });
      setTab("installed");
      return result;
    }, `${name} installed`);
  };

  const updateRemote = (name: string) => {
    void run(async () => {
      const result = await window.ePi.packages.update({ cwd, source: `npm:${name}` });
      return result;
    }, `${name} updated`);
  };

  // Packages already installed in this workspace (any scope), matched by
  // bare npm name so `npm:@scope/name` and `@scope/name` both line up.
  const installedNames = useMemo(() => new Set(packages.map((item) => item.source.replace(/^npm:/, ""))), [packages]);

  // Installs always target the user (global) scope; legacy project-scope
  // entries can still coexist, so collapse the same source to one row
  // (project record wins, mirroring pi's project-over-global dedupe).
  const displayPackages = useMemo(() => {
    const bySource = new Map<string, PackageRecord>();
    for (const item of packages) {
      const existing = bySource.get(item.source);
      if (!existing || item.scope === "project") bySource.set(item.source, item);
    }
    return [...bySource.values()];
  }, [packages]);

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
            onValueChange={(value) => switchTab(value as "installed" | "explore")}
            aria-label="Package panel"
          >
            <TabsList>
              <TabsTrigger value="installed" onClick={() => switchTab("installed")}>
                Installed
              </TabsTrigger>
              <TabsTrigger value="explore" onClick={() => switchTab("explore")}>
                Explore
              </TabsTrigger>
            </TabsList>
          </Tabs>
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
                      <CloudSync size={14} className={checkingUpdates ? "package-spin" : undefined} />
                    </IconButton>
                    <IconButton
                      label="Update all packages"
                      onClick={() => void run(() => window.ePi.packages.update({ cwd }), "All packages updated")}
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

                {displayPackages.length === 0 && !busy ? (
                  <div className="package-empty">No packages installed</div>
                ) : (
                  <div className="package-list">
                    {displayPackages.map((item) => {
                      const updateInfo = updates.find((candidate) => candidate.source === item.source);
                      const homeUrl = packageHomeUrl(item.source);
                      return (
                        <div className="package-row" key={item.source}>
                          <HoverCard openDelay={300}>
                            <HoverCardTrigger asChild>
                              <div className="package-row-main">
                                <strong title={item.source}>
                                  {homeUrl ? (
                                    <a className="package-link" href={homeUrl} target="_blank" rel="noreferrer">
                                      {item.source}
                                    </a>
                                  ) : (
                                    item.source
                                  )}
                                </strong>
                                <span>{item.version ? `v${item.version}` : "version unknown"}</span>
                              </div>
                            </HoverCardTrigger>
                            <HoverCardContent className="package-hover-card" side="left" sideOffset={12} align="center">
                              <InstalledPackageCard item={item} updateInfo={updateInfo} />
                            </HoverCardContent>
                          </HoverCard>
                          <div className="package-row-side">
                            <div className="package-row-actions">
                              {updateInfo ? (
                                <IconButton
                                  className="package-update-action"
                                  label={`Update ${item.source}${updateInfo.latestVersion ? ` to v${updateInfo.latestVersion}` : ""}`}
                                  onClick={() =>
                                    void run(() => window.ePi.packages.update({ cwd, source: item.source }))
                                  }
                                  disabled={busy}
                                >
                                  <ArrowBigUpDash size={14} />
                                </IconButton>
                              ) : null}
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <IconButton label={`Remove ${item.source}`} disabled={busy}>
                                    <PackageX size={14} />
                                  </IconButton>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>Remove package?</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      {item.source} will be removed from the configured package list.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction
                                      onClick={() =>
                                        void run(
                                          () => window.ePi.packages.remove({ source: item.source, cwd }),
                                          `${item.source} removed`,
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
            className={`package-pane${tab === "explore" ? "" : " package-pane-hidden"}`}
            aria-hidden={tab !== "explore"}
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
                {!searching && remotePackages.length === 0 ? (
                  <div className="package-empty">
                    {searchQuery.trim() ? "No packages found" : "Search for Pi packages published on npm"}
                  </div>
                ) : (
                  <div className="package-list">
                    {remotePackages.map((pkg) => {
                      const installed = installedNames.has(pkg.name);
                      const updateInfo = updates.find(
                        (candidate) => candidate.source.replace(/^npm:/, "").replace(/@[^/]+$/, "") === pkg.name,
                      );
                      return (
                        <div className="package-row" key={pkg.name}>
                          <HoverCard openDelay={300}>
                            <HoverCardTrigger asChild>
                              <div className="package-row-main">
                                <strong title={pkg.name}>
                                  <a
                                    className="package-link"
                                    href={`https://www.npmjs.com/package/${pkg.name}`}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    {pkg.name}
                                  </a>
                                </strong>
                                <span>v{pkg.version}</span>
                              </div>
                            </HoverCardTrigger>
                            <HoverCardContent className="package-hover-card" side="left" sideOffset={12} align="center">
                              <ExplorePackageCard pkg={pkg} />
                            </HoverCardContent>
                          </HoverCard>
                          <div className="package-row-side">
                            {installed && updateInfo ? (
                              <IconButton
                                className="package-update-action"
                                label={`Update ${pkg.name}${updateInfo.latestVersion ? ` to v${updateInfo.latestVersion}` : ""}`}
                                onClick={() => updateRemote(pkg.name)}
                                disabled={busy}
                              >
                                <ArrowBigUpDash size={14} />
                              </IconButton>
                            ) : (
                              <IconButton
                                label={installed ? "Installed" : `Install ${pkg.name}`}
                                onClick={() => installRemote(pkg.name)}
                                disabled={busy || installed}
                              >
                                {installed ? <PackageCheck size={14} /> : <PackagePlus size={14} />}
                              </IconButton>
                            )}
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
