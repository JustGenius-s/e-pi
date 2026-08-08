import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { app } from "electron";

/**
 * Single source of truth for where the bundled `@earendil-works/pi-coding-agent`
 * package lives, and for loading it into the main process.
 *
 * Why this exists: packaged builds unpack `node_modules` to
 * `app.asar.unpacked`, but the package's `package.json` still sits inside the
 * read-only asar. A plain `import "@earendil-works/pi-coding-agent"` in the
 * main process resolves through that asar stub, so after an in-place update
 * (which swaps the unpacked files) the main process keeps loading *old* entry
 * code from the asar that references files that only exist on disk — crashing
 * on the next launch with ERR_MODULE_NOT_FOUND. Loading through here always
 * reads the real, writable, updated files.
 */

/** Re-exported so callers keep their types without a static import. */
export type PiAgent = typeof import("@earendil-works/pi-coding-agent");

const require = createRequire(import.meta.url);

let cached: Promise<PiAgent> | undefined;

/**
 * Absolute path of the pi-coding-agent package directory.
 *
 * - `PI_PACKAGE_DIR` overrides everything (tests sandbox the update swap).
 * - Packaged: `process.resourcesPath/app.asar.unpacked/node_modules/...`. If the unpacked copy is missing (unexpected),
 *   fall back to resolving the asar copy so the app still starts.
 * - Dev/test: resolve through Node from this file (no electron needed).
 */
/** True when running inside a packaged app (safe to call with a mocked electron). */
function isPackaged(): boolean {
  try {
    return Boolean(app?.isPackaged) && typeof process.resourcesPath === "string";
  } catch {
    // Tests mock the electron module without `app` (a throwing proxy).
    return false;
  }
}

/**
 * Dev-only directory where an in-place update stages the newer pi package,
 * keeping the pnpm store pristine. `userData` is per-app and outside the
 * project, so a dev update never touches `node_modules` — and never leaks
 * into a later `dist:*` build.
 */
function devUpdateDir(): string | undefined {
  try {
    return join(app.getPath("userData"), "pi-agent");
  } catch {
    return undefined;
  }
}

export function piPackageDir(): string {
  const custom = process.env.PI_PACKAGE_DIR?.trim();
  if (custom) return custom;

  if (isPackaged()) {
    const unpacked = join(
      process.resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    if (existsSync(join(unpacked, "package.json"))) return unpacked;
    // Unexpected: no unpacked copy. Resolve the asar copy instead of crashing.
    return resolveFromAsar(unpacked);
  }

  // Dev: a previously applied update lives outside node_modules and takes
  // precedence, so the runtime picks it up without touching the pnpm store.
  const updated = devUpdateDir();
  if (updated && existsSync(join(updated, "package.json"))) return updated;

  return resolveFromHere();
}

/**
 * The directory an in-place update swaps into. In packaged builds that is the
 * live package dir (app.asar.unpacked); in dev it is the isolated userData
 * location, so the pnpm store is never overwritten.
 */
export function piUpdateTargetDir(): string {
  const custom = process.env.PI_PACKAGE_DIR?.trim();
  if (custom) return custom;
  if (isPackaged()) return piPackageDir();
  const updated = devUpdateDir();
  if (updated) return updated;
  // No userData (tests without electron): fall back to the resolved dir.
  return piPackageDir();
}

/** Walk up from the asar entry to the package root (update target fallback). */
function resolveFromAsar(fallback: string): string {
  try {
    const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    let dir = dirname(entry);
    for (;;) {
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        try {
          const name = (JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: unknown }).name;
          if (name === "@earendil-works/pi-coding-agent") {
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
  } catch {
    // Resolution failed entirely.
  }
  return fallback;
}

function resolveFromHere(): string {
  // The package's `exports` are ESM-only, so neither require.resolve(entry)
  // nor require.resolve(package.json) works from CJS. Walk the module lookup
  // paths and find the package directory on disk directly.
  const candidates = require.resolve.paths("@earendil-works/pi-coding-agent") ?? [];
  for (const modulesDir of candidates) {
    const dir = join(modulesDir, "@earendil-works", "pi-coding-agent");
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    try {
      const name = (JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: unknown }).name;
      if (name === "@earendil-works/pi-coding-agent") return dir;
    } catch {
      // Malformed package.json — try the next candidate.
    }
  }
  throw new Error("Could not locate the @earendil-works/pi-coding-agent package directory.");
}

/** Entry file (dist/index.js) of the pi package. */
export function piAgentEntry(): string {
  return join(piPackageDir(), "dist", "index.js");
}

/** CLI file (dist/cli.js) spawned for each session process. */
export function piCliEntry(): string {
  return join(piPackageDir(), "dist", "cli.js");
}

/**
 * Load the pi-coding-agent API from the real package files (never the asar).
 * Cached after the first successful load. On failure the cache is cleared so
 * a later call can retry.
 */
export function loadPiAgent(): Promise<PiAgent> {
  if (!cached) {
    cached = import(pathToFileURL(piAgentEntry()).href) as Promise<PiAgent>;
    cached.catch(() => {
      cached = undefined;
    });
  }
  return cached;
}
