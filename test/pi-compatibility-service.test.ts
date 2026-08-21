import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyPiCompatibilityPatches,
  applyUnifiedPatch,
  canLoadPiPackage,
  hasPiCompatibilityPatch,
  isPiCompatibilityApplied,
  preparePiPackageForMode,
} from "../electron/main/services/pi-compatibility-service";

const roots: string[] = [];

function temporaryDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), name));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.E_PI_COMPATIBILITY_PATCH_DIR;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("applyUnifiedPatch", () => {
  it("applies multiple hunks after upstream line offsets", () => {
    const root = temporaryDir("e-pi-unified-");
    writeFileSync(join(root, "sample.js"), "upstream\nalpha\nbeta\ngamma\n", "utf8");

    applyUnifiedPatch(
      root,
      [
        "diff --git a/sample.js b/sample.js",
        "--- a/sample.js",
        "+++ b/sample.js",
        "@@ -1,2 +1,2 @@",
        " alpha",
        "-beta",
        "+patched",
        "@@ -3,1 +3,2 @@",
        " gamma",
        "+tail",
        "",
      ].join("\n"),
    );

    expect(readFileSync(join(root, "sample.js"), "utf8")).toBe("upstream\nalpha\npatched\ngamma\ntail\n");
  });

  it("does not write a file when a hunk conflicts", () => {
    const root = temporaryDir("e-pi-unified-conflict-");
    const target = join(root, "sample.js");
    writeFileSync(target, "upstream changed\n", "utf8");

    expect(() =>
      applyUnifiedPatch(
        root,
        "diff --git a/sample.js b/sample.js\n--- a/sample.js\n+++ b/sample.js\n@@ -1 +1 @@\n-old\n+new\n",
      ),
    ).toThrow("no longer applies cleanly");
    expect(readFileSync(target, "utf8")).toBe("upstream changed\n");
  });

  it("tolerates changed context at a hunk edge without relaxing the edited lines", () => {
    const root = temporaryDir("e-pi-unified-fuzz-");
    const target = join(root, "sample.js");
    writeFileSync(target, "upstream context\nold\ntail\n", "utf8");

    applyUnifiedPatch(
      root,
      [
        "diff --git a/sample.js b/sample.js",
        "--- a/sample.js",
        "+++ b/sample.js",
        "@@ -1,3 +1,3 @@",
        " original context",
        "-old",
        "+new",
        " tail",
        "",
      ].join("\n"),
    );

    expect(readFileSync(target, "utf8")).toBe("upstream context\nnew\ntail\n");
  });
});

describe("applyPiCompatibilityPatches", () => {
  it("keeps Pi's stock transcript and status dock ownership while disabled", () => {
    const packageDir = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent");
    const source = readFileSync(join(packageDir, "dist", "modes", "interactive", "interactive-mode.js"), "utf8");

    expect(source).toContain("externalComposer ? new Container() : this.documentContainer");
    expect(source).toContain("fullscreenTranscriptContainer.addChild(new Spacer(4))");
    expect(source).toMatch(
      /component: this\.pendingMessagesContainer[^]*component: this\.statusContainer[^]*component: this\.widgetContainerAbove/,
    );
    expect(isPiCompatibilityApplied(packageDir)).toBe(true);
    expect(preparePiPackageForMode(packageDir, true)).toBe(true);
  });

  it("applies both compatibility patches and is idempotent", () => {
    const packageDir = temporaryDir("e-pi-package-");
    const patchDir = temporaryDir("e-pi-patches-");
    const interactive = join(packageDir, "dist", "modes", "interactive");
    const tui = join(packageDir, "node_modules", "@earendil-works", "pi-tui", "dist");
    mkdirSync(interactive, { recursive: true });
    mkdirSync(join(tui, "components"), { recursive: true });
    writeFileSync(join(tui, "..", "package.json"), JSON.stringify({ name: "@earendil-works/pi-tui" }), "utf8");
    writeFileSync(join(interactive, "interactive-mode.js"), "const mode = 'stock';\n", "utf8");
    writeFileSync(join(tui, "components", "markdown.js"), "let renderInvalidationRevision = 0;\n", "utf8");
    writeFileSync(join(tui, "components", "scroll-view.js"), "class ScrollView {}\n", "utf8");
    writeFileSync(join(tui, "components", "text.js"), "let renderInvalidationRevision = 0;\n", "utf8");
    writeFileSync(join(tui, "layout.js"), "const scrollVirtualStart = 0;\n", "utf8");
    writeFileSync(join(tui, "tui-alt-screen.js"), "const prefix = '';\n", "utf8");
    writeFileSync(join(tui, "tui.js"), "let renderInvalidationRevision = 0;\n", "utf8");

    writeFileSync(
      join(patchDir, "pi-coding-agent.patch"),
      [
        "diff --git a/dist/modes/interactive/interactive-mode.js b/dist/modes/interactive/interactive-mode.js",
        "--- a/dist/modes/interactive/interactive-mode.js",
        "+++ b/dist/modes/interactive/interactive-mode.js",
        "@@ -1 +1,5 @@",
        " const mode = 'stock';",
        '+const externalComposer = process.env.E_PI === "true" && process.env.E_PI_TUI_OPTIMIZATIONS === "true";',
        "+const fullscreenTranscriptContainer = externalComposer ? new Container() : this.documentContainer;",
        "+fullscreenTranscriptContainer.addChild(new Spacer(4));",
        "+component.ePiVirtualRenderVolatile = true;",
        "+component.ePiNavUserMessage = true;",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(patchDir, "pi-tui.patch"),
      [
        "diff --git a/dist/components/scroll-view.js b/dist/components/scroll-view.js",
        "--- a/dist/components/scroll-view.js",
        "+++ b/dist/components/scroll-view.js",
        "@@ -1 +1,2 @@",
        " class ScrollView {}",
        "+function renderVirtualViewport(width) { return width; }",
        "+// scrollToVirtualBlock(component) {}",
        "+// getVirtualBlockOffsets(components) {}",
        "diff --git a/dist/tui-alt-screen.js b/dist/tui-alt-screen.js",
        "--- a/dist/tui-alt-screen.js",
        "+++ b/dist/tui-alt-screen.js",
        "@@ -1 +1,2 @@",
        " const prefix = '';",
        "+const EPI_VIEWPORT_OSC_PREFIX = prefix;",
        "+const EPI_NAV_OSC_PREFIX = prefix;",
        "+function buildEPiNavOsc(primaryScrollView) { return primaryScrollView; }",
        "",
      ].join("\n"),
      "utf8",
    );
    process.env.E_PI_COMPATIBILITY_PATCH_DIR = patchDir;

    expect(preparePiPackageForMode(packageDir, true)).toBe(true);
    applyPiCompatibilityPatches(packageDir);

    expect(isPiCompatibilityApplied(packageDir)).toBe(true);
    expect(hasPiCompatibilityPatch(packageDir)).toBe(true);
    expect(canLoadPiPackage(packageDir, true)).toBe(true);
    expect(canLoadPiPackage(packageDir, false)).toBe(true);
    expect(preparePiPackageForMode(packageDir, false)).toBe(true);
  });

  it("accepts stock Pi only while the optimization patch is disabled", () => {
    const packageDir = temporaryDir("e-pi-stock-package-");
    expect(hasPiCompatibilityPatch(packageDir)).toBe(false);
    expect(canLoadPiPackage(packageDir, false)).toBe(true);
    expect(canLoadPiPackage(packageDir, true)).toBe(false);
    expect(preparePiPackageForMode(packageDir, false)).toBe(true);
    expect(preparePiPackageForMode(packageDir, true)).toBe(false);
  });

  it("leaves the stock package untouched when either dependency patch conflicts", () => {
    const packageDir = temporaryDir("e-pi-package-conflict-");
    const patchDir = temporaryDir("e-pi-patches-conflict-");
    const interactive = join(packageDir, "dist", "modes", "interactive");
    const tui = join(packageDir, "node_modules", "@earendil-works", "pi-tui", "dist");
    mkdirSync(interactive, { recursive: true });
    mkdirSync(join(tui, "components"), { recursive: true });
    writeFileSync(join(tui, "..", "package.json"), JSON.stringify({ name: "@earendil-works/pi-tui" }), "utf8");

    const interactivePath = join(interactive, "interactive-mode.js");
    writeFileSync(interactivePath, "const mode = 'stock';\n", "utf8");
    writeFileSync(join(tui, "components", "scroll-view.js"), "upstream changed\n", "utf8");
    writeFileSync(
      join(patchDir, "pi-coding-agent.patch"),
      [
        "diff --git a/dist/modes/interactive/interactive-mode.js b/dist/modes/interactive/interactive-mode.js",
        "--- a/dist/modes/interactive/interactive-mode.js",
        "+++ b/dist/modes/interactive/interactive-mode.js",
        "@@ -1 +1,5 @@",
        " const mode = 'stock';",
        '+const externalComposer = process.env.E_PI === "true" && process.env.E_PI_TUI_OPTIMIZATIONS === "true";',
        "+const fullscreenTranscriptContainer = externalComposer ? new Container() : this.documentContainer;",
        "+fullscreenTranscriptContainer.addChild(new Spacer(4));",
        "+component.ePiVirtualRenderVolatile = true;",
        "+component.ePiNavUserMessage = true;",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(patchDir, "pi-tui.patch"),
      [
        "diff --git a/dist/components/scroll-view.js b/dist/components/scroll-view.js",
        "--- a/dist/components/scroll-view.js",
        "+++ b/dist/components/scroll-view.js",
        "@@ -1 +1 @@",
        "-class ScrollView {}",
        "+function renderVirtualViewport(width) { return width; }",
        "+// scrollToVirtualBlock(component) {}",
        "+// getVirtualBlockOffsets(components) {}",
        "",
      ].join("\n"),
      "utf8",
    );
    process.env.E_PI_COMPATIBILITY_PATCH_DIR = patchDir;

    expect(() => applyPiCompatibilityPatches(packageDir)).toThrow("no longer applies cleanly");
    expect(readFileSync(interactivePath, "utf8")).toBe("const mode = 'stock';\n");
  });
});
