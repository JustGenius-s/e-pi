import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { DefaultPackageManager, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { net } from "electron";

import type {
  PackageMutation,
  PackageProgress,
  PackageRecord,
  PackageUpdateInfo,
  PackageUpdateRequest,
  RemotePackageInfo,
} from "../../../src/types/contracts";

export type PackageProgressListener = (progress: PackageProgress) => void;

const execFileAsync = promisify(execFile);
/** How long update-check results are kept before hitting the registry again. */
const UPDATES_TTL_MS = 5 * 60_000;
const NPM_VIEW_TIMEOUT_MS = 20_000;
const NPM_SEARCH_TIMEOUT_MS = 15_000;
const NPM_SEARCH_URL = "https://registry.npmjs.org/-/v1/search";
/** How long the last registry search result is kept; makes tab switches instant. */
const SEARCH_TTL_MS = 10 * 60_000;

function readPackageVersion(installedPath: string): string | undefined {
  try {
    const raw = readFileSync(join(installedPath, "package.json"), "utf8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" && version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pi treats any source without a scheme prefix (npm:/git:/github:/http:...) as
 * a local path. Bare npm package specs are the common input, so add the `npm:`
 * prefix for anything that clearly is one — matching the official
 * `pi install npm:@scope/name` form. Local paths and unknown inputs stay as-is.
 */
function normalizePackageSource(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) return trimmed;
  if (/^(npm:|git:|github:|http:|https:|ssh:|file:)/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.startsWith("~/")) {
    return trimmed;
  }
  // npm package spec: [@scope/]name[@version]
  if (/^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(@[^/]+)?$/.test(trimmed)) {
    return `npm:${trimmed}`;
  }
  return trimmed;
}

export class PackageService {
  #progressListener: PackageProgressListener | undefined;
  #updatesCache: { key: string; at: number; updates: PackageUpdateInfo[] } | undefined;
  #searchCache: { key: string; at: number; results: RemotePackageInfo[] } | undefined;

  setProgressListener(listener: PackageProgressListener | undefined): void {
    this.#progressListener = listener;
  }

  list(cwd: string): PackageRecord[] {
    return this.#listWithVersions(this.#manager(cwd));
  }

  #listWithVersions(manager: DefaultPackageManager): PackageRecord[] {
    return manager.listConfiguredPackages().map((record) => ({
      ...record,
      version: record.installedPath ? readPackageVersion(record.installedPath) : undefined,
    }));
  }

  /**
   * Check the registry/remotes for available updates. Delegates the actual
   * comparison to pi's package manager and resolves the concrete newest
   * version only for packages that have one pending. Cached per cwd.
   */
  async checkUpdates(cwd: string, force = false): Promise<PackageUpdateInfo[]> {
    const now = Date.now();
    if (
      !force &&
      this.#updatesCache &&
      this.#updatesCache.key === cwd &&
      now - this.#updatesCache.at < UPDATES_TTL_MS
    ) {
      return this.#updatesCache.updates;
    }
    const available = await this.#manager(cwd).checkForAvailableUpdates();
    const updates = await Promise.all(
      available.map(async (info) => ({
        ...info,
        latestVersion: info.type === "npm" ? await this.#latestNpmVersion(cwd, info.displayName) : undefined,
      })),
    );
    this.#updatesCache = { key: cwd, at: now, updates };
    return updates;
  }

  /**
   * Search the npm registry for Pi packages, filtered by the `pi-package`
   * keyword and ranked by popularity. Uses the official registry search API
   * through Electron's network stack, cached briefly per query.
   */
  async searchRemote(query: string): Promise<RemotePackageInfo[]> {
    const key = query.trim().toLowerCase();
    const now = Date.now();
    if (this.#searchCache && this.#searchCache.key === key && now - this.#searchCache.at < SEARCH_TTL_MS) {
      return this.#searchCache.results;
    }
    const text = key ? `keywords:pi-package ${key}` : "keywords:pi-package";
    const url = `${NPM_SEARCH_URL}?text=${encodeURIComponent(text)}&size=24&popularity=1.0`;
    const response = await net.fetch(url, { signal: AbortSignal.timeout(NPM_SEARCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`npm search failed (HTTP ${response.status})`);
    const data = (await response.json()) as {
      objects?: Array<{
        package: {
          name: string;
          description?: string;
          version: string;
          date?: string;
          keywords?: string[];
          author?: string | { name?: string; username?: string; email?: string } | undefined;
          publisher?: { username?: string };
        };
        score?: { popularity?: number };
      }>;
    };
    const results = (data.objects ?? []).map((entry) => {
      const pkg = entry.package;
      const author =
        typeof pkg.author === "string"
          ? pkg.author
          : (pkg.author?.name ?? pkg.author?.username ?? pkg.publisher?.username);
      return {
        name: pkg.name,
        description: pkg.description,
        version: pkg.version,
        date: pkg.date,
        author,
        keywords: pkg.keywords,
        popularity: entry.score?.popularity,
      };
    });
    this.#searchCache = { key, at: now, results };
    return results;
  }

  async install(request: PackageMutation): Promise<PackageRecord[]> {
    const source = normalizePackageSource(request.source);
    const manager = this.#manager(request.cwd);
    try {
      await manager.installAndPersist(source, { local: request.scope === "project" });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      throw new Error(`Failed to install ${source}: ${message}`, { cause: reason });
    }
    return this.#listWithVersions(manager);
  }

  async remove(request: PackageMutation): Promise<PackageRecord[]> {
    const source = normalizePackageSource(request.source);
    const manager = this.#manager(request.cwd);
    await manager.removeAndPersist(source, { local: request.scope === "project" });
    return this.#listWithVersions(manager);
  }

  async update(request: PackageUpdateRequest): Promise<PackageRecord[]> {
    const source = request.source ? normalizePackageSource(request.source) : undefined;
    const manager = this.#manager(request.cwd);
    await manager.update(source);
    return this.#listWithVersions(manager);
  }

  /** Resolve the newest published version of an npm package via `npm view`. */
  async #latestNpmVersion(cwd: string, packageName: string): Promise<string | undefined> {
    const settingsManager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: true });
    const configured = settingsManager.getNpmCommand();
    const [command, ...args] = configured && configured.length > 0 ? configured : ["npm"];
    try {
      const { stdout } = await execFileAsync(command, [...args, "view", packageName, "version"], {
        cwd,
        timeout: NPM_VIEW_TIMEOUT_MS,
        windowsHide: true,
      });
      const version = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => /^v?\d+\.\d+\.\d+/.test(line));
      return version ? version.replace(/^v/, "") : undefined;
    } catch {
      return undefined;
    }
  }

  #manager(cwd: string): DefaultPackageManager {
    const settingsManager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: true });
    const manager = new DefaultPackageManager({
      cwd,
      agentDir: getAgentDir(),
      settingsManager,
    });
    manager.setProgressCallback((event) => this.#progressListener?.(event));
    return manager;
  }
}
