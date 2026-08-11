import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import { net } from "electron";

import type { PiUpdateInfo, PiUpdateResult } from "../../../src/types/contracts";
import { debugLog } from "./debug-log";
import { loadPiAgent, piPackageDir, piUpdateTargetDir } from "./pi-agent-loader";
import { applyPiCompatibilityPatches } from "./pi-compatibility-service";

/** Static fallback only; the real version is always read from disk. */
const PI_VERSION = "0.0.0";

const REGISTRY_URL = "https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest";
const TARBALL_URL = "https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-";
const CHECK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
/** How long a successful check is kept before hitting the registry again. */
const CACHE_TTL_MS = 10 * 60 * 1000;
export const PI_COMPATIBILITY_REQUIRED_PREFIX = "E_PI_TUI_COMPATIBILITY_REQUIRED";

let cached: { at: number; latest: string | undefined } | undefined;

/** Test hook: isolate registry/update cache state between cases. */
export function resetPiUpdateCacheForTests(): void {
  cached = undefined;
}

const execFileAsync = promisify(execFile);

/**
 * Compare dotted version strings; missing segments count as zero.
 * Exported for tests.
 */
export function versionGt(a: string, b: string): boolean {
  const pa = a.split(".").map((part) => parseInt(part, 10) || 0);
  const pb = b.split(".").map((part) => parseInt(part, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/**
 * Check the npm registry for the newest pi release. Cached briefly; failures
 * keep the previous result (or report no update) instead of throwing. The
 * current version is read from disk so an in-place update is reflected
 * immediately (the bundled VERSION constant is static).
 */
export async function checkPiUpdate(): Promise<PiUpdateInfo> {
  const current = readInstalledPiVersion() || PI_VERSION;
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return { current, latest: cached.latest };
  }
  try {
    const response = await net.fetch(REGISTRY_URL, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`registry responded ${response.status}`);
    const data = (await response.json()) as { version?: string };
    const latest = typeof data.version === "string" && versionGt(data.version, current) ? data.version : undefined;
    cached = { at: now, latest };
  } catch {
    if (!cached) cached = { at: now, latest: undefined };
  }
  return { current, latest: cached.latest };
}

/**
 * The directory the bundled pi-coding-agent package lives in. Delegates to
 * the shared loader so session spawning and main-process imports read the
 * exact same files. `PI_PACKAGE_DIR` overrides the location (tests).
 */
export function resolvePiPackageDir(): string {
  return piPackageDir();
}

/** Npm argv used for pi installs, honoring the user's `npmCommand` setting. */
async function npmCommand(): Promise<string[]> {
  try {
    const { SettingsManager, getAgentDir } = await loadPiAgent();
    const settingsManager = SettingsManager.create(process.cwd(), getAgentDir(), { projectTrusted: true });
    const configured = settingsManager.getNpmCommand();
    if (configured && configured.length > 0) return configured;
  } catch {
    // Fall through to plain npm.
  }
  return ["npm"];
}

function readVersion(packageDir: string): string | undefined {
  try {
    const raw = readFileSync(join(packageDir, "package.json"), "utf8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" && version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

function removeRecursive(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Version of the pi package currently on disk (reads the installed
 * package.json). Unlike the bundled `VERSION` constant this reflects an
 * in-place update immediately, without restarting the main process.
 */
export function readInstalledPiVersion(): string {
  return readVersion(resolvePiPackageDir()) ?? "";
}

/**
 * Apply a pi update in place.
 *
 * Steps:
 *
 * 1. Resolve the newest version and download its tarball.
 * 2. Extract the tarball with `tar` (its `.tgz` extension lets macOS tar detect gzip automatically), then strip the
 *    `devDependencies` the npm registry tarball ships with — npm chokes on their peer sets during a standalone
 *    install.
 * 3. Install the package's own dependencies with `npm install --omit=dev`, producing a self-contained package directory.
 * 4. Reapply and validate E-Pi's TUI compatibility layer while the update is still staged.
 * 5. Atomically swap it into the location of the bundled pi package (rename the old directory aside, move the new one in),
 *    then delete the old one. The swap is all within one filesystem, so `renameSync` is atomic; the package's own
 *    node_modules are outside the asar in packaged builds, so they can be written freely.
 * 6. The caller restarts every live session so they pick up the new version.
 *
 * Throws on any failure and leaves the existing installation untouched.
 */
export async function applyPiUpdate(
  options: { tuiOptimizationsEnabled?: boolean; allowStockFallback?: boolean } = {},
): Promise<PiUpdateResult> {
  // Read the *current* version from the live dir, but swap into the update
  // target — in dev these differ (target is userData, not the pnpm store).
  const installedDir = piUpdateTargetDir();
  const current = readInstalledPiVersion() || PI_VERSION;
  const info = await checkPiUpdate();
  const latest = info.latest;
  if (!latest) {
    throw new Error("No pi update available.");
  }

  // Stage next to the target so the final renameSync stays on one filesystem
  // (renameSync is atomic only within a single volume; tmpdir may differ).
  const workDir = mkdtempSync(join(dirname(installedDir), ".e-pi-update-"));
  try {
    const tarballPath = join(workDir, `pi-coding-agent-${latest}.tgz`);
    const tarballUrl = `${TARBALL_URL}${encodeURIComponent(latest)}.tgz`;
    debugLog("[pi-update] downloading", { latest, url: tarballUrl });
    const response = await net.fetch(tarballUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`npm tarball responded ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    writeFileSync(tarballPath, data);

    // macOS/Windows tar auto-detect gzip from the .tgz extension; the bundled
    // sidecar Node does not ship tar, so use the system `tar` from PATH.
    await execFileAsync("tar", ["-xzf", tarballPath, "-C", workDir], { timeout: DOWNLOAD_TIMEOUT_MS });
    const extracted = join(workDir, "package");
    if (!existsSync(join(extracted, "package.json"))) {
      throw new Error("Downloaded pi package has no package.json.");
    }

    const staged = join(workDir, "pi-coding-agent");
    renameSync(extracted, staged);

    // Strip devDependencies: the published tarball carries them (including
    // vitest, whose peer sets crash npm's arborist during a standalone
    // install), and they are not needed at runtime.
    const pkgPath = join(staged, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
    delete pkg.devDependencies;
    delete pkg.scripts;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    debugLog("[pi-update] installing dependencies", { latest });
    const [command, ...args] = await npmCommand();
    await execFileAsync(
      command,
      [
        ...args,
        "install",
        "--no-save",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
      ],
      { cwd: staged, timeout: INSTALL_TIMEOUT_MS, windowsHide: true },
    );
    if (!existsSync(join(staged, "node_modules"))) {
      throw new Error("Dependency install produced no node_modules.");
    }
    // The runtime spawns dist/cli.js directly; refuse to swap in a package
    // the session launcher could not start.
    if (!existsSync(join(staged, "dist", "cli.js"))) {
      throw new Error("Downloaded pi package is missing dist/cli.js.");
    }

    let fallbackToStock = false;
    if (options.tuiOptimizationsEnabled !== false) {
      debugLog("[pi-update] applying E-Pi compatibility layer", { latest });
      try {
        applyPiCompatibilityPatches(staged);
      } catch (cause) {
        if (!options.allowStockFallback) {
          throw new Error(
            `${PI_COMPATIBILITY_REQUIRED_PREFIX}:${latest}:Pi ${latest} changed TUI internals used by E-Pi's optimization patch.`,
            { cause },
          );
        }
        fallbackToStock = true;
        debugLog("[pi-update] compatibility failed; continuing with stock pi-tui", { latest });
      }
    } else {
      debugLog("[pi-update] keeping stock pi-tui (optimization patch disabled)", { latest });
    }

    // Atomic swap within one filesystem.
    const parent = dirname(installedDir);
    const backup = join(parent, `.${basename(installedDir)}.old-${Date.now()}`);
    const installedVersion = readVersion(staged);
    if (!installedVersion) throw new Error("Installed package has no version.");
    debugLog("[pi-update] swapping", { installedDir, staged, installedVersion });
    if (existsSync(backup)) removeRecursive(backup);
    // In dev the target (userData/pi-agent) may not exist yet on the first
    // update — there is no prior install to back up, so just move in.
    const hadPrevious = existsSync(installedDir);
    if (hadPrevious) renameSync(installedDir, backup);
    try {
      renameSync(staged, installedDir);
    } catch (error) {
      // Restore the previous install before rethrowing.
      if (hadPrevious) renameSync(backup, installedDir);
      throw error;
    }
    if (hadPrevious) removeRecursive(backup);

    // Keep the version cache in sync so the next check reports up to date.
    cached = { at: Date.now(), latest: undefined };
    debugLog("[pi-update] done", { from: current, to: installedVersion, path: installedDir });
    return { from: current, to: installedVersion, path: installedDir, fallbackToStock };
  } finally {
    removeRecursive(workDir);
  }
}
