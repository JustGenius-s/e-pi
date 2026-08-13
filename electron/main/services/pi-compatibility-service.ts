import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

type UnifiedHunk = {
  oldStart: number;
  lines: string[];
};

type UnifiedFilePatch = {
  path: string;
  hunks: UnifiedHunk[];
};

type PlannedFileChange = {
  target: string;
  original: string;
  content: string;
};

const PATCH_SPECS = [
  {
    names: ["pi-coding-agent.patch", "@earendil-works__pi-coding-agent@0.84.0.patch"],
    target: (packageDir: string) => packageDir,
  },
  {
    names: ["pi-tui.patch", "@earendil-works__pi-tui@0.84.0.patch"],
    target: (packageDir: string) => resolvePiTuiDir(packageDir),
  },
] as const;

const PI_TUI_PROBE_PREFIX = "node_modules/@earendil-works/pi-tui/";

const COMPATIBILITY_PROBES = [
  ["dist/modes/interactive/interactive-mode.js", "E_PI_TUI_OPTIMIZATIONS"],
  ["dist/modes/interactive/interactive-mode.js", 'const externalComposer = process.env.E_PI === "true"'],
  ["dist/modes/interactive/interactive-mode.js", "externalComposer ? new Container() : this.documentContainer"],
  ["dist/modes/interactive/interactive-mode.js", "fullscreenTranscriptContainer.addChild(new Spacer(4))"],
  ["dist/modes/interactive/interactive-mode.js", "component.ePiVirtualRenderVolatile = true"],
  ["dist/modes/interactive/interactive-mode.js", "component.ePiNavUserMessage = true"],
  ["node_modules/@earendil-works/pi-tui/dist/components/markdown.js", "renderInvalidationRevision"],
  ["node_modules/@earendil-works/pi-tui/dist/components/scroll-view.js", "renderVirtualViewport(width"],
  ["node_modules/@earendil-works/pi-tui/dist/components/scroll-view.js", "scrollToVirtualBlock(component)"],
  ["node_modules/@earendil-works/pi-tui/dist/components/scroll-view.js", "getVirtualBlockOffsets(components)"],
  ["node_modules/@earendil-works/pi-tui/dist/components/text.js", "renderInvalidationRevision"],
  ["node_modules/@earendil-works/pi-tui/dist/layout.js", "scrollVirtualStart"],
  ["node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js", "EPI_VIEWPORT_OSC_PREFIX"],
  ["node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js", "EPI_NAV_OSC_PREFIX"],
  ["node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js", "buildEPiNavOsc(primaryScrollView)"],
  ["node_modules/@earendil-works/pi-tui/dist/tui.js", "renderInvalidationRevision"],
] as const;

const PATCH_PRESENCE_PROBES = [
  ["dist/modes/interactive/interactive-mode.js", "ePiVirtualRenderVolatile"],
  ["node_modules/@earendil-works/pi-tui/dist/components/scroll-view.js", "renderVirtualViewport(width"],
] as const;

/** Npm updates nest pi-tui; pnpm/electron packaging may place it beside Pi. */
function resolvePiTuiDir(packageDir: string): string {
  const candidates = [
    join(packageDir, "node_modules", "@earendil-works", "pi-tui"),
    join(resolve(packageDir, ".."), "pi-tui"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  throw new Error("Could not locate Pi's @earendil-works/pi-tui dependency.");
}

function compatibilityProbePath(packageDir: string, relativePath: string): string {
  if (relativePath.startsWith(PI_TUI_PROBE_PREFIX)) {
    return join(resolvePiTuiDir(packageDir), relativePath.slice(PI_TUI_PROBE_PREFIX.length));
  }
  return join(packageDir, relativePath);
}

function parseUnifiedPatch(source: string): UnifiedFilePatch[] {
  const lines = source.split("\n");
  const files: UnifiedFilePatch[] = [];
  let current: UnifiedFilePatch | undefined;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith("+++ ")) {
      const rawPath = line.slice(4).split("\t", 1)[0];
      if (rawPath === "/dev/null") throw new Error("Compatibility patches may not delete files.");
      current = { path: rawPath.startsWith("b/") ? rawPath.slice(2) : rawPath, hunks: [] };
      files.push(current);
      continue;
    }
    if (!line.startsWith("@@ ")) continue;
    if (!current) throw new Error("Malformed compatibility patch: hunk has no target file.");

    const match = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (!match) throw new Error(`Malformed compatibility patch hunk: ${line}`);
    const hunk: UnifiedHunk = { oldStart: Number(match[1]), lines: [] };
    current.hunks.push(hunk);
    index++;
    while (index < lines.length) {
      const hunkLine = lines[index];
      if (hunkLine.startsWith("@@ ") || hunkLine.startsWith("diff --git ") || hunkLine.startsWith("--- ")) {
        index--;
        break;
      }
      if (hunkLine.startsWith("\\ No newline at end of file")) {
        index++;
        continue;
      }
      if (hunkLine.startsWith(" ") || hunkLine.startsWith("+") || hunkLine.startsWith("-")) {
        hunk.lines.push(hunkLine);
        index++;
        continue;
      }
      index--;
      break;
    }
  }

  if (files.length === 0) throw new Error("Compatibility patch contains no files.");
  return files;
}

function linesMatch(lines: string[], start: number, expected: string[]): boolean {
  if (start < 0 || start + expected.length > lines.length) return false;
  return expected.every((line, index) => lines[start + index] === line);
}

function locateLines(lines: string[], expected: string[], preferred: number): number {
  if (linesMatch(lines, preferred, expected)) return preferred;

  let closest = -1;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index <= lines.length - expected.length; index++) {
    if (!linesMatch(lines, index, expected)) continue;
    const distance = Math.abs(index - preferred);
    if (distance < closestDistance) {
      closest = index;
      closestDistance = distance;
    }
  }
  return closest;
}

function locateHunk(
  lines: string[],
  hunk: UnifiedHunk,
  preferred: number,
): { position: number; before: string[]; after: string[] } | undefined {
  const leadingContext = hunk.lines.findIndex((line) => line[0] !== " ");
  const trailingContext = [...hunk.lines].reverse().findIndex((line) => line[0] !== " ");
  const maxLeadingFuzz = Math.min(3, leadingContext < 0 ? hunk.lines.length : leadingContext);
  const maxTrailingFuzz = Math.min(3, trailingContext < 0 ? hunk.lines.length : trailingContext);

  for (let totalFuzz = 0; totalFuzz <= maxLeadingFuzz + maxTrailingFuzz; totalFuzz++) {
    for (let leadingFuzz = 0; leadingFuzz <= Math.min(maxLeadingFuzz, totalFuzz); leadingFuzz++) {
      const trailingFuzz = totalFuzz - leadingFuzz;
      if (trailingFuzz > maxTrailingFuzz) continue;
      const end = hunk.lines.length - trailingFuzz;
      const candidate = hunk.lines.slice(leadingFuzz, end);
      const before = candidate.filter((line) => line[0] !== "+").map((line) => line.slice(1));
      const after = candidate.filter((line) => line[0] !== "-").map((line) => line.slice(1));
      // A context-only or fully trimmed hunk is not a safe anchor.
      if (before.length === 0 || candidate.every((line) => line[0] === " ")) continue;
      const position = locateLines(lines, before, preferred + leadingFuzz);
      if (position >= 0) return { position, before, after };
    }
  }
  return undefined;
}

function applyFilePatch(source: string, patch: UnifiedFilePatch): string {
  const trailingNewline = source.endsWith("\n");
  const lines = source.split("\n");
  if (trailingNewline) lines.pop();
  let offset = 0;

  for (const hunk of patch.hunks) {
    const preferred = Math.max(0, hunk.oldStart - 1 + offset);
    const located = locateHunk(lines, hunk, preferred);
    if (!located) {
      throw new Error(`Compatibility patch no longer applies cleanly to ${patch.path} near line ${hunk.oldStart}.`);
    }
    lines.splice(located.position, located.before.length, ...located.after);
    offset += located.after.length - located.before.length;
  }

  return `${lines.join("\n")}${trailingNewline ? "\n" : ""}`;
}

function planUnifiedPatch(
  rootDir: string,
  patchSource: string,
  changes = new Map<string, PlannedFileChange>(),
): Map<string, PlannedFileChange> {
  const root = resolve(rootDir);
  for (const patch of parseUnifiedPatch(patchSource)) {
    const target = resolve(root, patch.path);
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new Error(`Compatibility patch escapes its target directory: ${patch.path}`);
    }
    if (!existsSync(target)) throw new Error(`Compatibility patch target is missing: ${patch.path}`);

    const previous = changes.get(target);
    const original = previous?.original ?? readFileSync(target, "utf8");
    const source = previous?.content ?? original;
    changes.set(target, { target, original, content: applyFilePatch(source, patch) });
  }
  return changes;
}

function commitPlannedChanges(changes: Map<string, PlannedFileChange>, validate?: () => boolean): void {
  const written: PlannedFileChange[] = [];
  try {
    for (const change of changes.values()) {
      writeFileSync(change.target, change.content, "utf8");
      written.push(change);
    }
    if (validate && !validate()) throw new Error("Pi update did not pass E-Pi's TUI compatibility checks.");
  } catch (cause) {
    for (const change of written.reverse()) writeFileSync(change.target, change.original, "utf8");
    throw cause;
  }
}

/** Apply a standard unified diff without relying on a system `patch` binary. */
export function applyUnifiedPatch(rootDir: string, patchSource: string): void {
  commitPlannedChanges(planUnifiedPatch(rootDir, patchSource));
}

export function isPiCompatibilityApplied(packageDir: string): boolean {
  return COMPATIBILITY_PROBES.every(([relativePath, marker]) => {
    try {
      return readFileSync(compatibilityProbePath(packageDir, relativePath), "utf8").includes(marker);
    } catch {
      return false;
    }
  });
}

export function hasPiCompatibilityPatch(packageDir: string): boolean {
  return PATCH_PRESENCE_PROBES.some(([relativePath, marker]) => {
    try {
      return readFileSync(compatibilityProbePath(packageDir, relativePath), "utf8").includes(marker);
    } catch {
      return false;
    }
  });
}

/** Stock packages are valid while disabled; enabled mode requires the complete gated patch. */
export function canLoadPiPackage(packageDir: string, optimizationsEnabled: boolean): boolean {
  if (optimizationsEnabled) return isPiCompatibilityApplied(packageDir);
  return !hasPiCompatibilityPatch(packageDir) || isPiCompatibilityApplied(packageDir);
}

/**
 * Prepare a package selected by the runtime, including packages installed
 * outside E-Pi's update button. Enabled mode injects the compatibility layer
 * transactionally; disabled mode never writes and only accepts stock Pi or a
 * complete env-gated patch.
 */
export function preparePiPackageForMode(packageDir: string, optimizationsEnabled: boolean): boolean {
  if (!optimizationsEnabled) return canLoadPiPackage(packageDir, false);
  if (isPiCompatibilityApplied(packageDir)) return true;
  try {
    applyPiCompatibilityPatches(packageDir);
    return true;
  } catch {
    return false;
  }
}

function compatibilityPatchDir(): string {
  const override = process.env.E_PI_COMPATIBILITY_PATCH_DIR?.trim();
  if (override) return override;

  if (typeof process.resourcesPath === "string") {
    const packaged = join(process.resourcesPath, "pi-compatibility");
    if (existsSync(packaged)) return packaged;
  }
  return join(process.cwd(), "patches");
}

function resolvePatchFile(dir: string, names: readonly string[]): string {
  for (const name of names) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Missing E-Pi compatibility patch (${names.join(" or ")}).`);
}

/**
 * Reapply E-Pi's TUI contract to a freshly downloaded Pi package. The update
 * service calls this while the package is still staged, so any upstream
 * conflict aborts before the live installation is replaced.
 */
export function applyPiCompatibilityPatches(packageDir: string): void {
  if (isPiCompatibilityApplied(packageDir)) return;

  const patchDir = compatibilityPatchDir();
  const changes = new Map<string, PlannedFileChange>();
  for (const spec of PATCH_SPECS) {
    const patchPath = resolvePatchFile(patchDir, spec.names);
    planUnifiedPatch(spec.target(packageDir), readFileSync(patchPath, "utf8"), changes);
  }

  // Plan both dependency patches before touching disk. If either patch no
  // longer matches a newer Pi release, enabling the optimization leaves the
  // currently installed stock package byte-for-byte unchanged.
  commitPlannedChanges(changes, () => isPiCompatibilityApplied(packageDir));
}
