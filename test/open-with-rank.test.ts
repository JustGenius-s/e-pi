import { describe, expect, it } from "vitest";

import {
  affinitiesForExtension,
  isJunkAppPath,
  rankOpenWithApps,
  type RankableApp,
} from "../electron/main/services/open-with-rank";

function app(name: string, path = `/Applications/${name}.app`): RankableApp {
  return { id: path, name, path };
}

describe("affinitiesForExtension", () => {
  it("maps png to image, pptx to slides, css to code then web", () => {
    expect(affinitiesForExtension("png")).toEqual(["image"]);
    expect(affinitiesForExtension(".PPTX")).toEqual(["office-ppt"]);
    expect(affinitiesForExtension("css")).toEqual(["code", "web"]);
    expect(affinitiesForExtension("ts")).toEqual(["code"]);
    expect(affinitiesForExtension("")).toEqual(["code"]);
  });
});

describe("isJunkAppPath", () => {
  it("drops cache, playwright, and runtime copies", () => {
    expect(isJunkAppPath("/Applications/Preview.app")).toBe(false);
    expect(isJunkAppPath("/Users/me/Library/Caches/ms-playwright/chromium-1/Google Chrome for Testing.app")).toBe(true);
    expect(isJunkAppPath("/Users/me/.cache/codex-runtimes/libreoffice/LibreOfficeDev.app")).toBe(true);
    expect(isJunkAppPath("/Users/me/.chromium-browser-snapshots/chromium/chrome-mac/Chromium.app")).toBe(true);
  });
});

describe("rankOpenWithApps", () => {
  it("puts Preview first for png and keeps browsers below image tools", () => {
    const ranked = rankOpenWithApps(
      [
        app("Google Chrome"),
        app("ColorSync Utility"),
        app("Preview", "/System/Applications/Preview.app"),
        app("Photoshop"),
        app("BaiduNetdisk_mac"),
      ],
      { extension: "png", defaultAppPath: "/System/Applications/Preview.app" },
    );
    expect(ranked.map((entry) => entry.name).slice(0, 3)).toEqual(["Preview", "Photoshop", "Google Chrome"]);
    expect(ranked.at(-1)?.name).toBe("BaiduNetdisk_mac");
    expect(ranked.findIndex((entry) => entry.name === "ColorSync Utility")).toBeGreaterThan(
      ranked.findIndex((entry) => entry.name === "Google Chrome"),
    );
  });

  it("puts slide apps above generic wrappers for pptx, keeping the user default first", () => {
    const ranked = rankOpenWithApps(
      [app("ChatGPT"), app("wpsoffice"), app("Keynote Creator Studio"), app("LibreOffice"), app("ima.copilot")],
      { extension: "pptx", defaultAppPath: "/Applications/Keynote Creator Studio.app" },
    );
    expect(ranked[0].name).toBe("Keynote Creator Studio");
    expect(ranked.slice(1, 3).map((entry) => entry.name)).toEqual(["wpsoffice", "LibreOffice"]);
    expect(ranked.findIndex((entry) => entry.name === "ChatGPT")).toBeGreaterThan(
      ranked.findIndex((entry) => entry.name === "LibreOffice"),
    );
  });

  it("puts editors above Safari for css even when Safari is the system default", () => {
    const ranked = rankOpenWithApps(
      [
        app("Safari", "/System/Applications/Safari.app"),
        app("TextEdit"),
        app("Cursor"),
        app("CodeBuddy CN"),
        app("Google Chrome"),
      ],
      { extension: "css", defaultAppPath: "/System/Applications/Safari.app" },
    );
    expect(ranked.slice(0, 3).map((entry) => entry.name)).toEqual(["Cursor", "CodeBuddy CN", "TextEdit"]);
    expect(ranked.findIndex((entry) => entry.name === "Safari")).toBeGreaterThan(
      ranked.findIndex((entry) => entry.name === "Cursor"),
    );
  });

  it("demotes QuickTime for TypeScript even though .ts is also MPEG-TS", () => {
    const ranked = rankOpenWithApps([app("QuickTime Player"), app("Cursor"), app("Zed")], {
      extension: "ts",
      defaultAppPath: "/Applications/QuickTime Player.app",
    });
    expect(ranked[0].name).toBe("Cursor");
    expect(ranked.map((entry) => entry.name).slice(-1)).toEqual(["QuickTime Player"]);
  });

  it("dedupes duplicate app names", () => {
    const ranked = rankOpenWithApps([app("Stik", "/A/Stik.app"), app("Stik", "/B/Stik.app"), app("Cursor")], {
      extension: "md",
    });
    expect(ranked.filter((entry) => entry.name === "Stik")).toHaveLength(1);
  });
});
