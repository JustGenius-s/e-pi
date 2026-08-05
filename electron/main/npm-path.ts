import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { app } from "electron";

/**
 * Finder-launched packaged apps run with a minimal PATH (/usr/bin:/bin:...)
 * that usually doesn't include npm. pi's package manager spawns `npm` by bare
 * name with `process.env`, so installs in the packaged app fail with
 * `spawn npm ENOENT`. Resolve npm's directory — the bundled sidecar Node
 * first, then common install locations — and prepend it to PATH so the spawn
 * resolves.
 *
 * Returns the resolved npm directory, or undefined when npm was not found.
 */
export function ensureNpmOnPath(): string | undefined {
  const npmDir = findNpmDir();
  if (!npmDir) return undefined;
  const separator = process.platform === "win32" ? ";" : ":";
  const current = process.env.PATH ?? "";
  const parts = current.split(separator).filter(Boolean);
  if (parts.includes(npmDir)) return npmDir;
  process.env.PATH = `${npmDir}${separator}${current}`;
  return npmDir;
}

/**
 * The sidecar Node shipped in `resources/node` (packaged: Contents/Resources/node).
 * Only used in packaged builds — in dev the user's own npm is on PATH, and
 * the repo's `"type": "module"` package.json would misclassify the bundle's
 * CJS CLI scripts under the project tree.
 */
function bundledNodeBinDir(): string | undefined {
  if (!app.isPackaged) return undefined;
  const bin = join(process.resourcesPath, "node", "bin");
  if (existsSync(join(bin, "node")) && existsSync(join(bin, "npm"))) return bin;
  return undefined;
}

function findNpmDir(): string | undefined {
  const isWin = process.platform === "win32";
  const names = isWin ? ["npm.cmd", "npm"] : ["npm"];
  const separator = isWin ? ";" : ":";
  const pathDirs = (process.env.PATH ?? "").split(separator).filter(Boolean);
  const candidates = [bundledNodeBinDir(), ...pathDirs, ...getCommonDirs(isWin)].filter(
    (dir): dir is string => typeof dir === "string" && dir.length > 0,
  );
  // Prefer directories that also provide `node` — npm's shebang resolves it
  // through PATH, so a bare npm binary alone would still fail to run.
  for (const dir of candidates) {
    if (
      dir &&
      names.some((name) => existsSync(join(dir, name))) &&
      existsSync(join(dir, isWin ? "node.exe" : "node"))
    ) {
      return dir;
    }
  }
  for (const dir of candidates) {
    if (dir && names.some((name) => existsSync(join(dir, name)))) return dir;
  }
  return undefined;
}

function getCommonDirs(isWin: boolean): string[] {
  const home = homedir();
  const dirs = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    process.env.npm_config_prefix ?? "",
    ...listBinDirs(join(home, ".nvm/versions/node")),
    ...listBinDirs(join(home, ".fnm/node-versions")),
    ...listBinDirs(join(home, ".local/share/fnm/node-versions")),
    join(home, ".volta/bin"),
    ...listBinDirs(join(home, ".asdf/installs/nodejs")),
  ];
  if (isWin) {
    dirs.push(process.env.APPDATA ? join(process.env.APPDATA, "npm") : "", "C:\\Program Files\\nodejs");
  }
  return dirs.filter((dir) => dir.length > 0);
}

/**
 * Version-pinned node installs keep npm in `<root>/<version>/bin` (nvm, asdf)
 * or `<root>/<version>/installation/bin` (fnm).
 */
function listBinDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  const dirs: string[] = [];
  try {
    const entries = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    // Newest version first, so the resolved npm comes from the most recent node.
    entries.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
    for (const entry of entries) {
      for (const bin of [join(root, entry.name, "bin"), join(root, entry.name, "installation", "bin")]) {
        if (existsSync(bin)) dirs.push(bin);
      }
    }
  } catch {
    // Unreadable dirs are simply skipped.
  }
  return dirs;
}
