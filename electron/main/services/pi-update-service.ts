import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { getAgentDir, SettingsManager, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { net } from "electron";

import type { PiUpdateInfo, PiUpdateResult } from "../../../src/types/contracts";
import { debugLog } from "./debug-log";

const REGISTRY_URL = "https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest";
const TARBALL_URL = "https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-";
const CHECK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
/** How long a successful check is kept before hitting the registry again. */
const CACHE_TTL_MS = 10 * 60 * 1000;

let cached: { at: number; latest: string | undefined } | undefined;

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
 * The directory the bundled pi-coding-agent package lives in. In dev that is
 * the pnpm store (where `import.meta.resolve` points); packaged builds unpack
 * `node_modules` to `app.asar.unpacked`. The package's own files (dist, docs,
 * examples) sit here; `package.json` is the only file the app bundles inside
 * the asar itself. Resolving it at runtime keeps updates working after a swap.
 * `PI_PACKAGE_DIR` overrides the location (used by tests to sandbox swaps).
 */
export function resolvePiPackageDir(): string {
  const custom = process.env.PI_PACKAGE_DIR?.trim();
  if (custom) return custom;
  // import.meta.resolve returns the package *entry file* (e.g. dist/index.js),
  // so walk up until we find the package.json that names this package.
  let dir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  for (;;) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const name = (JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: unknown }).name;
        if (name === "@earendil-works/pi-coding-agent") {
          // In packaged builds the resolver returns an app.asar path. The asar
          // is read-only; the real writable files live in app.asar.unpacked
          // (electron-builder unpacks node_modules there). Map the path over
          // so the in-place update can actually write files.
          const unpacked = dir.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
          if (unpacked !== dir && existsSync(join(unpacked, "package.json"))) return unpacked;
          return dir;
        }
      } catch {
        // Malformed package.json — keep walking up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate the @earendil-works/pi-coding-agent package directory.");
}

/** npm argv used for pi installs, honoring the user's `npmCommand` setting. */
function npmCommand(): string[] {
  try {
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
 * 1. Resolve the newest version and download its tarball.
 * 2. Extract the tarball with `tar` (its `.tgz` extension lets macOS tar
 *    detect gzip automatically), then strip the `devDependencies` the npm
 *    registry tarball ships with — npm chokes on their peer sets during a
 *    standalone install.
 * 3. Install the package's own dependencies with `npm install --omit=dev`,
 *    producing a self-contained package directory.
 * 4. Atomically swap it into the location of the bundled pi package (rename
 *    the old directory aside, move the new one in), then delete the old one.
 *    The swap is all within one filesystem, so `renameSync` is atomic; the
 *    package's own node_modules are outside the asar in packaged builds, so
 *    they can be written freely.
 * 5. The caller restarts every live session so they pick up the new version.
 *
 * Throws on any failure and leaves the existing installation untouched.
 */
export async function applyPiUpdate(): Promise<PiUpdateResult> {
  const installedDir = resolvePiPackageDir();
  const current = readVersion(installedDir) || PI_VERSION;
  const info = await checkPiUpdate();
  const latest = info.latest;
  if (!latest) {
    throw new Error("No pi update available.");
  }

  const workDir = mkdtempSync(join(tmpdir(), "e-pi-update-"));
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
    const [command, ...args] = npmCommand();
    await execFileAsync(
      command,
      [...args, "install", "--no-save", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"],
      { cwd: staged, timeout: INSTALL_TIMEOUT_MS, windowsHide: true },
    );
    if (!existsSync(join(staged, "node_modules"))) {
      throw new Error("Dependency install produced no node_modules.");
    }

    // Atomic swap within one filesystem.
    const parent = dirname(installedDir);
    const backup = join(parent, `.${basename(installedDir)}.old-${Date.now()}`);
    const installedVersion = readVersion(staged);
    if (!installedVersion) throw new Error("Installed package has no version.");
    debugLog("[pi-update] swapping", { installedDir, staged, installedVersion });
    if (existsSync(backup)) removeRecursive(backup);
    renameSync(installedDir, backup);
    try {
      renameSync(staged, installedDir);
    } catch (error) {
      // Restore the previous install before rethrowing.
      renameSync(backup, installedDir);
      throw error;
    }
    removeRecursive(backup);

    // Keep the version cache in sync so the next check reports up to date.
    cached = { at: Date.now(), latest: undefined };
    debugLog("[pi-update] done", { from: current, to: installedVersion, path: installedDir });
    return { from: current, to: installedVersion, path: installedDir };
  } finally {
    removeRecursive(workDir);
  }
}
