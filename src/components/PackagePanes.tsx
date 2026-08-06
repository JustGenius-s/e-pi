import { ArrowBigUpDash, CloudSync, Package, PackageCheck, PackagePlus, PackageX, Search } from "lucide-react";
import { useEffect, useState } from "react";

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
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card";
import { Input } from "./ui/input";

const downloadsCache = new Map<string, PackageDownloads>();

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
  return github ? `https://github.com/${github[1]}/${github[2]}` : undefined;
}

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
    const cached = downloadsCache.get(name);
    if (cached) {
      setState({ status: "ready", downloads: cached });
      return;
    }
    setState({ status: "loading" });
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

function DownloadsStat({ name }: { name?: string }) {
  const { status, downloads } = usePackageDownloads(name);
  return (
    <dd className="package-hover-downloads">
      {status === "ready" && downloads ? formatDownloads(downloads.downloads) : status === "error" ? "—" : "…"}
    </dd>
  );
}

function InstalledPackageCard({ item, updateInfo }: { item: PackageRecord; updateInfo?: PackageUpdateInfo }) {
  const npmName = item.source.startsWith("npm:") ? item.source.slice(4) : undefined;
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
      {packageHomeUrl(item.source) ? (
        <a className="package-hover-link" href={packageHomeUrl(item.source)} target="_blank" rel="noreferrer">
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

export interface PackageMutationProps {
  cwd: string;
  busy: boolean;
  progress?: PackageProgress;
  run: (action: () => Promise<PackageRecord[]>, successMessage?: string) => void;
}

interface InstalledPackagesPaneProps extends PackageMutationProps {
  packages: PackageRecord[];
  updates: PackageUpdateInfo[];
  checkingUpdates: boolean;
  onCheckUpdates: () => void;
}

export function InstalledPackagesPane({
  packages,
  updates,
  checkingUpdates,
  onCheckUpdates,
  cwd,
  busy,
  progress,
  run,
}: InstalledPackagesPaneProps) {
  const bySource = new Map<string, PackageRecord>();
  for (const item of packages) {
    const existing = bySource.get(item.source);
    if (!existing || item.scope === "project") bySource.set(item.source, item);
  }
  const displayPackages = [...bySource.values()];
  return (
    <div className="package-drawer-body">
      <section className="package-list-section" aria-live="polite">
        <div className="section-heading-row">
          <h3>
            Installed <span>{packages.length}</span>
          </h3>
          <div className="section-heading-actions">
            <IconButton
              label="Check for updates"
              onClick={onCheckUpdates}
              disabled={busy || checkingUpdates || packages.length === 0}
            >
              <CloudSync size={14} className={checkingUpdates ? "package-spin" : undefined} />
            </IconButton>
            <IconButton
              label="Update all packages"
              onClick={() => run(() => window.ePi.packages.update({ cwd }), "All packages updated")}
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
                          onClick={() => run(() => window.ePi.packages.update({ cwd, source: item.source }))}
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
                                run(
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
  );
}

interface ExplorePackagesPaneProps extends PackageMutationProps {
  packages: PackageRecord[];
  updates: PackageUpdateInfo[];
  remotePackages: RemotePackageInfo[];
  searchQuery: string;
  searching: boolean;
  searchError?: string;
  onSearchQueryChange: (query: string) => void;
  onInstalled: () => void;
}

export function ExplorePackagesPane({
  packages,
  updates,
  remotePackages,
  searchQuery,
  searching,
  searchError,
  onSearchQueryChange,
  onInstalled,
  cwd,
  busy,
  run,
}: ExplorePackagesPaneProps) {
  const installedNames = new Set(packages.map((item) => item.source.replace(/^npm:/, "")));
  return (
    <div className="package-drawer-body">
      <section className="package-browse-section" aria-label="Browse packages">
        <div className="package-search-box">
          <Search size={13} />
          <Input
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
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
                        onClick={() =>
                          run(
                            () => window.ePi.packages.update({ cwd, source: `npm:${pkg.name}` }),
                            `${pkg.name} updated`,
                          )
                        }
                        disabled={busy}
                      >
                        <ArrowBigUpDash size={14} />
                      </IconButton>
                    ) : (
                      <IconButton
                        label={installed ? "Installed" : `Install ${pkg.name}`}
                        onClick={() =>
                          run(async () => {
                            const result = await window.ePi.packages.install({ source: `npm:${pkg.name}`, cwd });
                            onInstalled();
                            return result;
                          }, `${pkg.name} installed`)
                        }
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
  );
}
