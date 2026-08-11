import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronState = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronState.userData,
  },
}));

beforeEach(() => {
  electronState.userData = mkdtempSync(join(tmpdir(), "e-pi-app-settings-"));
  vi.resetModules();
});

afterEach(() => {
  rmSync(electronState.userData, { recursive: true, force: true });
});

describe("TUI optimization setting", () => {
  it("defaults to enabled for existing users without the setting", async () => {
    const settings = await import("../electron/main/services/app-settings-service");

    expect((await settings.getAppSettings()).tuiOptimizationsEnabled).toBe(true);
    expect(settings.isTuiOptimizationsEnabled()).toBe(true);
  });

  it("persists the disabled mode for synchronous package resolution", async () => {
    const settings = await import("../electron/main/services/app-settings-service");

    await settings.setTuiOptimizationsEnabled(false);

    expect(settings.isTuiOptimizationsEnabled()).toBe(false);
    const stored = JSON.parse(readFileSync(join(electronState.userData, "app-settings.json"), "utf8")) as {
      tuiOptimizationsEnabled: boolean;
    };
    expect(stored.tuiOptimizationsEnabled).toBe(false);
  });
});
