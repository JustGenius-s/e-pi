/**
 * Rank "Open With" candidates by how likely they are to be the right app
 * for a given file extension. Launch Services order is a useful default,
 * but a coding workspace wants Preview for png, Keynote/WPS for ppt, and
 * editors for css/ts — not Safari, QuickTime, or a cloud drive.
 */

export type OpenWithAffinity =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "office-ppt"
  | "office-doc"
  | "office-sheet"
  | "archive"
  | "code"
  | "web";

export interface RankableApp {
  id: string;
  name: string;
  path: string;
}

const IMAGE_EXT = set(
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "heic",
  "heif",
  "tif",
  "tiff",
  "avif",
  "psd",
  "ai",
);
const VIDEO_EXT = set("mp4", "mov", "mkv", "avi", "webm", "m4v", "m4p");
const AUDIO_EXT = set("mp3", "wav", "aac", "flac", "m4a", "aiff", "ogg");
const PDF_EXT = set("pdf");
const PPT_EXT = set("ppt", "pptx", "pps", "ppsx", "key", "odp");
const DOC_EXT = set("doc", "docx", "rtf", "odt", "pages");
const SHEET_EXT = set("xls", "xlsx", "csv", "tsv", "numbers", "ods");
const ARCHIVE_EXT = set("zip", "tar", "gz", "tgz", "bz2", "7z", "rar", "dmg");
const WEB_AND_CODE_EXT = set("html", "htm", "xhtml", "css", "scss", "less", "sass", "styl");
const CODE_EXT = set(
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "cxx",
  "hpp",
  "m",
  "mm",
  "cs",
  "php",
  "rb",
  "lua",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "sql",
  "proto",
  "graphql",
  "gql",
  "vue",
  "svelte",
  "astro",
  "toml",
  "json",
  "jsonc",
  "json5",
  "yaml",
  "yml",
  "xml",
  "md",
  "mdx",
  "markdown",
  "gradle",
  "dockerfile",
  "makefile",
  "rsx",
  "wasm",
  "tf",
  "hcl",
);

const APP_NEEDLES: Record<OpenWithAffinity, string[]> = {
  image: [
    "preview",
    "photos",
    "photoshop",
    "pixelmator",
    "lightroom",
    "affinity photo",
    "figma",
    "sketch",
    "illustrator",
    "gimp",
    "krita",
  ],
  video: ["quicktime", "iina", "vlc", "infuse", "mpv", "final cut", "premiere"],
  audio: ["music", "garageband", "audacity", "vlc", "iina"],
  pdf: ["preview", "acrobat", "pdf expert", "skim"],
  "office-ppt": ["keynote", "powerpoint", "wps", "wpsoffice", "libreoffice"],
  "office-doc": ["pages", "word", "wps", "wpsoffice", "libreoffice", "textedit", "typora", "obsidian", "bear"],
  "office-sheet": ["numbers", "excel", "wps", "wpsoffice", "libreoffice"],
  archive: ["archive utility", "the unarchiver", "keka", "betterzip"],
  code: [
    "cursor",
    "visual studio code",
    "visual studio",
    "vscode",
    "codebuddy",
    "zed",
    "sublime text",
    "sublime",
    "textmate",
    "bbedit",
    "macvim",
    "neovim",
    "emacs",
    "xcode",
    "webstorm",
    "pycharm",
    "intellij",
    "goland",
    "phpstorm",
    "clion",
    "rider",
    "rubymine",
    "fleet",
    "coteditor",
    "nova",
    "windsurf",
    "trae",
    "coderunner",
    "code",
    "vim",
  ],
  web: ["safari", "chrome", "firefox", "arc", "edge", "brave", "orion", "chromium", "vivaldi"],
};

const BROWSER_NEEDLES = APP_NEEDLES.web;
const VIDEO_NEEDLES = APP_NEEDLES.video;
const WEAK_CODE_NEEDLES = ["textedit"];
const LOW_QUALITY_NEEDLES = [
  "netdisk",
  "clouddrive",
  "cloud drive",
  "quark",
  "baidu",
  "chatgpt",
  "copilot",
  "workbuddy",
  "for testing",
];

const JUNK_PATH_FRAGMENTS = [
  "/Library/Caches/",
  "/.cache/",
  "/.chromium-browser-snapshots/",
  "/playwright/",
  "/codex-runtimes/",
  "/node_modules/",
  "/chrome-mac/",
];

export const MAX_OPEN_WITH_APPS = 15;

function set(...values: string[]): Set<string> {
  return new Set(values);
}

/** File-type affinities, strongest first. Empty extension (Makefile) counts as code. */
export function affinitiesForExtension(extension: string): OpenWithAffinity[] {
  const ext = extension.replace(/^\./, "").toLowerCase();
  if (!ext) return ["code"];
  if (IMAGE_EXT.has(ext)) return ["image"];
  if (VIDEO_EXT.has(ext)) return ["video"];
  if (AUDIO_EXT.has(ext)) return ["audio"];
  if (PDF_EXT.has(ext)) return ["pdf"];
  if (PPT_EXT.has(ext)) return ["office-ppt"];
  if (DOC_EXT.has(ext)) return ["office-doc"];
  if (SHEET_EXT.has(ext)) return ["office-sheet"];
  if (ARCHIVE_EXT.has(ext)) return ["archive"];
  if (WEB_AND_CODE_EXT.has(ext)) return ["code", "web"];
  if (CODE_EXT.has(ext)) return ["code"];
  return [];
}

/** Cache/testing copies that should never appear in Open With. */
export function isJunkAppPath(appPath: string): boolean {
  return JUNK_PATH_FRAGMENTS.some((fragment) => appPath.includes(fragment));
}

/** True when the app is a first-choice handler for this extension's category. */
export function hasPrimaryAffinity(appName: string, extension: string): boolean {
  const primary = affinitiesForExtension(extension)[0];
  if (!primary) return false;
  if (matchesAffinity(appName, primary)) return true;
  return primary === "code" && matchesAny(appName, WEAK_CODE_NEEDLES);
}

export function rankOpenWithApps<T extends RankableApp>(
  apps: T[],
  options: { extension: string; defaultAppPath?: string },
): T[] {
  const affinities = affinitiesForExtension(options.extension);
  const defaultPath = options.defaultAppPath ? normalizeAppPath(options.defaultAppPath) : undefined;
  const weights = scoringWeights(affinities);

  const unique = dedupeByName(apps);
  const scored = unique.map((app, index) => ({
    app,
    score: scoreApp(app, affinities, defaultPath, index, weights),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.app);
}

function scoringWeights(affinities: OpenWithAffinity[]): {
  primary: number;
  secondary: number;
  isDefault: number;
} {
  // Code files: editors outrank Launch Services defaults (Safari for css, QuickTime for ts).
  // Other types: keep the user's default first (Preview, Keynote, …).
  if (affinities[0] === "code") {
    return { primary: 400, secondary: 80, isDefault: 120 };
  }
  return { primary: 220, secondary: 80, isDefault: 500 };
}

function scoreApp(
  app: RankableApp,
  affinities: OpenWithAffinity[],
  defaultPath: string | undefined,
  index: number,
  weights: { primary: number; secondary: number; isDefault: number },
): number {
  let score = -index;
  if (defaultPath && normalizeAppPath(app.path) === defaultPath) score += weights.isDefault;

  if (affinities[0] === "code" && matchesAny(app.name, WEAK_CODE_NEEDLES) && !matchesAffinity(app.name, "code")) {
    score += 240;
  } else if (affinities[0] && matchesAffinity(app.name, affinities[0])) {
    score += weights.primary;
  } else if (affinities[1] && matchesAffinity(app.name, affinities[1])) {
    score += weights.secondary;
  }

  if (isLowQualityName(app.name)) score -= 320;
  if (isBrowser(app.name) && !affinities.includes("web")) {
    score -= affinities.includes("image") || affinities.includes("pdf") ? 70 : 160;
  }
  if (affinities[0] === "code" && matchesAny(app.name, VIDEO_NEEDLES)) score -= 220;
  if (/utility/i.test(app.name) && affinities[0] !== "archive") score -= 110;
  return score;
}

function matchesAffinity(appName: string, affinity: OpenWithAffinity): boolean {
  return matchesAny(appName, APP_NEEDLES[affinity]);
}

function isBrowser(appName: string): boolean {
  return matchesAny(appName, BROWSER_NEEDLES);
}

function isLowQualityName(appName: string): boolean {
  const name = appName.toLowerCase();
  return LOW_QUALITY_NEEDLES.some((needle) => name.includes(needle));
}

function matchesAny(appName: string, needles: string[]): boolean {
  return needles.some((needle) => matchesNeedle(appName, needle));
}

function matchesNeedle(appName: string, needle: string): boolean {
  const name = appName.toLowerCase();
  const key = needle.toLowerCase();
  if (key.includes(" ")) return name.includes(key);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(name);
}

function dedupeByName<T extends RankableApp>(apps: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const app of apps) {
    const key = app.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(app);
  }
  return unique;
}

function normalizeAppPath(appPath: string): string {
  return appPath.replace(/\/+$/, "").toLowerCase();
}
