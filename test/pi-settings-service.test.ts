import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUTO_THEME_SETTING,
  ensureAutoThemeSetting,
  ensureEpiLightThemeFile,
  getPiTuiSettings,
  savePiTuiSettings,
} from "../electron/main/services/pi-settings-service";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
  },
}));

let agentDir = "";

vi.stubEnv("PI_CODING_AGENT_DIR", "");

function settingsPath() {
  return join(agentDir, "settings.json");
}

function writeSettings(content: unknown) {
  writeFileSync(settingsPath(), JSON.stringify(content, null, 2), "utf8");
}

function readTheme(): string | undefined {
  try {
    return (JSON.parse(readFileSync(settingsPath(), "utf8")) as { theme?: string }).theme;
  } catch {
    return undefined;
  }
}

describe("pi-settings-service theme sync", () => {
  afterEach(() => {
    if (agentDir) rmSync(agentDir, { recursive: true, force: true });
    agentDir = "";
  });

  const useAgentDir = () => {
    agentDir = mkdtempSync(join(tmpdir(), "e-pi-agent-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    mkdirSync(agentDir, { recursive: true });
  };

  it("writes the auto theme setting when theme is missing", () => {
    useAgentDir();
    writeSettings({ quietStartup: true });
    ensureAutoThemeSetting();
    expect(readTheme()).toBe(AUTO_THEME_SETTING);
    // Other keys survive.
    expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toMatchObject({ quietStartup: true });
  });

  it("upgrades the default dark theme to the auto setting", () => {
    useAgentDir();
    writeSettings({ theme: "dark" });
    ensureAutoThemeSetting();
    expect(readTheme()).toBe(AUTO_THEME_SETTING);
  });

  it("upgrades the default light theme to the auto setting", () => {
    useAgentDir();
    writeSettings({ theme: "light" });
    ensureAutoThemeSetting();
    expect(readTheme()).toBe(AUTO_THEME_SETTING);
  });

  it("leaves a user-picked custom theme untouched", () => {
    useAgentDir();
    writeSettings({ theme: "my-theme" });
    ensureAutoThemeSetting();
    expect(readTheme()).toBe("my-theme");
  });

  it("is a no-op once the auto setting is already in place", () => {
    useAgentDir();
    writeSettings({ theme: AUTO_THEME_SETTING });
    ensureAutoThemeSetting();
    expect(readTheme()).toBe(AUTO_THEME_SETTING);
  });

  it("creates the file when missing and preserves tui settings round-trips", () => {
    useAgentDir();
    savePiTuiSettings({ quietStartup: true, hideThinkingBlock: false });
    expect(getPiTuiSettings()).toEqual({ quietStartup: true, hideThinkingBlock: false });
    ensureAutoThemeSetting();
    expect(readTheme()).toBe(AUTO_THEME_SETTING);
  });

  it("copies the E-Pi light theme into the agent themes dir and updates it", () => {
    useAgentDir();
    ensureEpiLightThemeFile(join(process.cwd(), "resources", "e-pi-light.json"));
    const target = join(agentDir, "themes", "e-pi-light.json");
    const source = join(process.cwd(), "resources", "e-pi-light.json");
    expect(readFileSync(target, "utf8")).toBe(readFileSync(source, "utf8"));

    // A stale target is refreshed on the next call.
    writeFileSync(target, "{}", "utf8");
    ensureEpiLightThemeFile();
    expect(readFileSync(target, "utf8")).toBe(readFileSync(source, "utf8"));
  });
});
