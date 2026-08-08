import { spawn, spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { app, nativeImage } from "electron";

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

// --- File-extension matching (CFBundleDocumentTypes from each app's Info.plist) ---

let plistIndex: { at: number; byExt: Map<string, MacApp[]>; matchesAll: MacApp[] } | undefined;

/** Apps declared (via Info.plist) to open the given lowercase extension. */
export async function appsForExtension(extension: string): Promise<MacApp[]> {
  const index = await buildPlistIndex();
  const ext = extension.replace(/^\./, "").toLowerCase();
  const matches = [...(index.byExt.get(ext) ?? []), ...index.matchesAll];
  if (matches.length === 0) return listDevApps(); // No declaration — fall back to dev tools.
  return matches;
}

/** Parse every app's Info.plist once, then cache the extension → apps map. */
async function buildPlistIndex(): Promise<{ byExt: Map<string, MacApp[]>; matchesAll: MacApp[] }> {
  if (plistIndex && Date.now() - plistIndex.at < CACHE_TTL_MS) return plistIndex;

  const apps = await listMacApps();
  const byExt = new Map<string, MacApp[]>();
  const matchesAll: MacApp[] = [];

  await Promise.all(
    apps.map(async (appEntry) => {
      const plistPath = join(appEntry.path, "Contents", "Info.plist");
      try {
        const result = spawnSync("plutil", ["-convert", "json", "-o", "-", plistPath], {
          encoding: "utf8",
          timeout: 5000,
        });
        if (result.status !== 0) return;
        const parsed = JSON.parse(result.stdout) as {
          CFBundleDocumentTypes?: Array<{ CFBundleTypeExtensions?: unknown[] }>;
        };
        for (const docType of parsed.CFBundleDocumentTypes ?? []) {
          for (const raw of docType.CFBundleTypeExtensions ?? []) {
            const declared = String(raw).toLowerCase();
            if (declared === "*" || declared === "**/*") {
              if (!matchesAll.some((x) => x.id === appEntry.id)) matchesAll.push(appEntry);
              continue;
            }
            const ext = declared.replace(/^\./, "");
            if (!ext) continue;
            const list = byExt.get(ext) ?? [];
            if (!list.some((x) => x.id === appEntry.id)) list.push(appEntry);
            byExt.set(ext, list);
          }
        }
      } catch {
        // Unreadable plist or no document types — not an open-with candidate.
      }
    }),
  );

  plistIndex = { at: Date.now(), byExt, matchesAll };
  return plistIndex;
}

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
