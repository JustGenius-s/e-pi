#!/usr/bin/env node
/**
 * Give the dev Electron app its own bundle id so macOS notification
 * permissions are not shared with every other com.github.Electron app
 * (CodeBuddy CN and friends share that identity, which makes dev-mode
 * notifications silently fail). The packaged app keeps its own appId, so
 * this only affects `pnpm dev`.
 *
 * pnpm install re-extracts the pristine Electron.app, so this script runs
 * before every `dev` start. It is idempotent: when the bundle id already
 * matches, it exits immediately.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE_ID = "com.justgenius.e-pi.dev";
const DISPLAY_NAME = "E-Pi Dev";

if (process.platform !== "darwin") {
  console.log("[dev-bundle-id] skipped (not macOS)");
  process.exit(0);
}

const require = createRequire(import.meta.url);
let electronDist;
try {
  electronDist = join(dirname(require.resolve("electron/package.json")), "dist");
} catch {
  console.log("[dev-bundle-id] skipped (electron not installed)");
  process.exit(0);
}

const appPath = join(electronDist, "Electron.app");
const plistPath = join(appPath, "Contents", "Info.plist");
if (!existsSync(plistPath)) {
  console.log("[dev-bundle-id] skipped (Electron.app not found)");
  process.exit(0);
}

const current = execFileSync("plutil", ["-extract", "CFBundleIdentifier", "raw", plistPath], {
  encoding: "utf8",
}).trim();
if (current === BUNDLE_ID) {
  console.log("[dev-bundle-id] ok");
  process.exit(0);
}

execFileSync("plutil", ["-replace", "CFBundleIdentifier", "-string", BUNDLE_ID, plistPath]);
execFileSync("plutil", ["-replace", "CFBundleDisplayName", "-string", DISPLAY_NAME, plistPath]);
// Editing the plist invalidates the ad-hoc signature; arm64 macOS refuses to
// launch unsigned code, so re-sign (ad-hoc) the whole bundle.
execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath]);
console.log(`[dev-bundle-id] ${current} -> ${BUNDLE_ID} (re-signed)`);
