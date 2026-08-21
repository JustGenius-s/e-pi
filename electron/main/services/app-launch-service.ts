import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

import { app, nativeImage } from "electron";

import { hasPrimaryAffinity, isJunkAppPath, MAX_OPEN_WITH_APPS, rankOpenWithApps } from "./open-with-rank";

export interface MacApp {
  /** Stable identifier — the .app bundle path. */
  id: string;
  /** Display name without the .app suffix. */
  name: string;
  path: string;
  /** 32×32 PNG data URL of the app icon; undefined when extraction failed. */
  icon?: string;
}

const APP_DIRS = [
  "/Applications",
  "/System/Applications",
  "/System/Applications/Utilities",
  join(homedir(), "Applications"),
];

/** How long a successful scan is kept before re-reading the app dirs. */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** Name keywords (lowercase) that mark an app as development-oriented. */
const DEV_KEYWORDS = [
  "xcode",
  "visual studio",
  "cursor",
  "zed",
  "sublime",
  "textmate",
  "bbedit",
  "vim",
  "neovim",
  "emacs",
  "intellij",
  "webstorm",
  "pycharm",
  "goland",
  "rider",
  "phpstorm",
  "datagrip",
  "clion",
  "rubymine",
  "fleet",
  "nova",
  "coteditor",
  "coderunner",
  "windsurf",
  "trae",
  "iterm",
  "ghostty",
  "warp",
  "alacritty",
  "kitty",
  "terminal",
  "postman",
  "tableplus",
  "dbeaver",
  "sequel",
  "postico",
  "navicat",
  "compass",
  "redis",
  "fork",
  "tower",
  "sourcetree",
  "github desktop",
  "figma",
  "sketch",
  "docker",
  "orbstack",
  "kaleidoscope",
  "hex fiend",
  "drawio",
  "omnigraffle",
  "beyond compare",
  "diffmerge",
  "kate",
  "geany",
  "atom",
  "brackets",
];

function isDevApp(name: string): boolean {
  const lower = name.toLowerCase();
  return DEV_KEYWORDS.some((keyword) => lower.includes(keyword));
}

let cached: { at: number; apps: MacApp[] } | undefined;

/** Scan the standard macOS app folders for .app bundles, sorted by name. */
export async function listMacApps(): Promise<MacApp[]> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.apps;

  const dirResults = await Promise.all(
    APP_DIRS.map(async (dir) => {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries
          .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
          .map((entry) => {
            const path = join(dir, entry.name);
            return { id: path, name: entry.name.replace(/\.app$/, ""), path };
          });
      } catch {
        return []; // Folder missing or unreadable — skip it.
      }
    }),
  );
  const apps: MacApp[] = dirResults.flat();
  apps.sort((a, b) => a.name.localeCompare(b.name, "en"));

  // app.getFileIcon() returns the generic macOS app icon for .app bundles, so
  // pull the real icon out of the bundle's .icns instead (fall back to
  // getFileIcon when there is no usable PNG inside).
  await Promise.all(
    apps.map(async (appEntry) => {
      try {
        appEntry.icon = (await iconFromBundle(appEntry.path)) ?? (await fallbackIcon(appEntry.path));
      } catch {
        // Broken bundle or no icon — keep the entry without one.
      }
    }),
  );

  cached = { at: Date.now(), apps };
  return apps;
}

/** Development-oriented apps for the top-right dropdown (cached scan + filter). */
export async function listDevApps(): Promise<MacApp[]> {
  const apps = await listMacApps();
  return apps.filter((appEntry) => isDevApp(appEntry.name));
}

// --- Open With (Launch Services + category ranking) ---

let handlersCache: { at: number; byExt: Map<string, LaunchServicesHandlers> } | undefined;

interface LaunchServicesHandlers {
  defaultApp: string;
  apps: string[];
}

/**
 * Apps that can open this extension, ranked for a coding workspace:
 * Preview for images, Keynote/WPS for slides, editors for css/ts, and so on.
 * Launch Services supplies the candidate set; category scoring reorders it.
 */
export async function appsForExtension(extension: string): Promise<MacApp[]> {
  const ext = extension.replace(/^\./, "").toLowerCase();
  const scanned = await listMacApps();
  const scannedByPath = new Map(scanned.map((entry) => [entry.path, entry]));
  const scannedByName = new Map(scanned.map((entry) => [entry.name.toLowerCase(), entry]));

  const resolved = new Map<string, MacApp>();
  const consider = (appPath: string) => {
    if (!appPath || isJunkAppPath(appPath) || !appPath.endsWith(".app")) return;
    const macApp = resolveMacApp(appPath, scannedByPath, scannedByName);
    if (!resolved.has(macApp.path)) resolved.set(macApp.path, macApp);
  };

  const handlers = queryLaunchServices(ext);
  for (const appPath of handlers.apps) consider(appPath);
  if (handlers.defaultApp) consider(handlers.defaultApp);

  const defaultApp = handlers.defaultApp ? resolveMacApp(handlers.defaultApp, scannedByPath, scannedByName) : undefined;

  // Launch Services misses some editors for ambiguous UTIs (.ts is MPEG-TS).
  // Add installed apps that are a first-choice handler for this file type.
  for (const entry of scanned) {
    if (resolved.has(entry.path)) continue;
    if (hasPrimaryAffinity(entry.name, ext)) consider(entry.path);
  }

  if (resolved.size === 0) {
    for (const entry of await listDevApps()) consider(entry.path);
  }

  const ranked = rankOpenWithApps([...resolved.values()], {
    extension: ext,
    defaultAppPath: defaultApp?.path,
  }).slice(0, MAX_OPEN_WITH_APPS);

  await Promise.all(
    ranked.map(async (entry) => {
      if (entry.icon) return;
      try {
        entry.icon = (await iconFromBundle(entry.path)) ?? (await fallbackIcon(entry.path));
      } catch {
        // Broken bundle — keep the row without an icon.
      }
    }),
  );

  return ranked;
}

function resolveMacApp(
  appPath: string,
  scannedByPath: Map<string, MacApp>,
  scannedByName: Map<string, MacApp>,
): MacApp {
  const normalized = appPath.replace(/\/+$/, "");
  const byPath = scannedByPath.get(normalized);
  if (byPath) return byPath;
  const name = basename(normalized).replace(/\.app$/i, "");
  const byName = scannedByName.get(name.toLowerCase());
  if (byName) return byName;
  return { id: normalized, name, path: normalized };
}

/**
 * Ask NSWorkspace which apps can open a file of this type (Finder's Open With).
 * Uses a tiny temp file so we don't need UniformTypeIdentifiers (JXA can't import it).
 */
function queryLaunchServices(extension: string): LaunchServicesHandlers {
  const empty: LaunchServicesHandlers = { defaultApp: "", apps: [] };
  if (handlersCache && Date.now() - handlersCache.at < CACHE_TTL_MS) {
    const cachedHandlers = handlersCache.byExt.get(extension);
    if (cachedHandlers) return cachedHandlers;
  } else {
    handlersCache = { at: Date.now(), byExt: new Map() };
  }

  const safeExt = extension.replace(/[^a-z0-9._-]+/gi, "").slice(0, 20);
  const probe = join(tmpdir(), safeExt ? `e-pi-open-with.${safeExt}` : "e-pi-open-with-file");
  try {
    writeFileSync(probe, "");
  } catch {
    return empty;
  }

  const result = spawnSync("osascript", ["-l", "JavaScript", "-e", LIST_HANDLERS_JXA, "--", probe], {
    encoding: "utf8",
    timeout: 8000,
  });
  if (result.status !== 0) {
    handlersCache.byExt.set(extension, empty);
    return empty;
  }

  try {
    const parsed = JSON.parse(result.stdout.trim()) as { defaultApp?: string; apps?: string[] };
    const handlers: LaunchServicesHandlers = {
      defaultApp: typeof parsed.defaultApp === "string" ? parsed.defaultApp : "",
      apps: Array.isArray(parsed.apps) ? parsed.apps.filter((path) => typeof path === "string") : [],
    };
    handlersCache.byExt.set(extension, handlers);
    return handlers;
  } catch {
    handlersCache.byExt.set(extension, empty);
    return empty;
  }
}

const LIST_HANDLERS_JXA = `
function run(argv) {
  ObjC.import("AppKit");
  var filePath = argv[0];
  if (!filePath) return JSON.stringify({ defaultApp: "", apps: [] });
  var url = $.NSURL.fileURLWithPath(filePath);
  var ws = $.NSWorkspace.sharedWorkspace;
  var def = ws.URLForApplicationToOpenURL(url);
  var apps = ws.URLsForApplicationsToOpenURL(url);
  var paths = [];
  for (var i = 0; i < apps.count; i++) {
    paths.push(ObjC.unwrap(apps.objectAtIndex(i).path));
  }
  var defaultApp = "";
  try { defaultApp = ObjC.unwrap(def.path); } catch (e) {}
  return JSON.stringify({ defaultApp: defaultApp, apps: paths });
}
`.trim();

/** Open `filePath` with the given .app bundle. macOS only (`open -a`). */
export function openWithApp(appPath: string, filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("open", ["-a", appPath, filePath], { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`open exited with code ${code}`));
    });
  });
}

/** Native macOS "choose an application" dialog; resolves with the .app path or undefined when cancelled. */
export function chooseAppFromSystem(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn("osascript", [
      "-e",
      'POSIX path of (choose application with prompt "选择要打开的应用" as alias)',
    ]);
    let out = "";
    child.stdout.on("data", (data: Buffer) => {
      out += data.toString();
    });
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => {
      // Exit -128 (or non-zero) = user cancelled the dialog.
      resolve(code === 0 ? out.trim() || undefined : undefined);
    });
  });
}

/** Real bundle icon (32×32 PNG data URL) by extracting the PNG from the .icns. */
async function iconFromBundle(appPath: string): Promise<string | undefined> {
  const resDir = join(appPath, "Contents", "Resources");
  const entries = await readdir(resDir);
  const icnsName = entries.find((entry) => entry.endsWith(".icns"));
  if (!icnsName) return undefined;

  const data = await readFile(join(resDir, icnsName));
  const png = extractLargestPngChunk(data);
  if (!png) return undefined;

  const image = nativeImage.createFromBuffer(png);
  if (image.isEmpty()) return undefined;
  return image.resize({ width: 32, height: 32 }).toDataURL();
}

/** Icns container: "icns" magic, then chunks of [4-byte type][4-byte BE length][data]. */
function extractLargestPngChunk(icns: Buffer): Buffer | undefined {
  if (icns.length < 8 || icns.toString("latin1", 0, 4) !== "icns") return undefined;
  let best: Buffer | undefined;
  let bestLength = 0;
  let offset = 8;
  while (offset + 8 <= icns.length) {
    const length = icns.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > icns.length) break;
    const chunk = icns.subarray(offset + 8, offset + length);
    // Modern icns files embed real PNGs (older ones use JPEG2000 — skip those).
    if (chunk.length > bestLength && chunk.length >= 8 && chunk[0] === 0x89 && chunk[1] === 0x50) {
      best = chunk;
      bestLength = chunk.length;
    }
    offset += length;
  }
  return best;
}

/** NSWorkspace fallback — generic icon, but better than nothing. */
async function fallbackIcon(appPath: string): Promise<string | undefined> {
  const icon = await app.getFileIcon(appPath, { size: "normal" });
  return icon.isEmpty() ? undefined : icon.toDataURL();
}
