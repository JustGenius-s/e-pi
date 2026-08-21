import { describe, expect, it, vi } from "vitest";

import { applyEpiTheme, applyThemeFromHint, readThemeHint } from "../resources/e-pi-bridge";

describe("readThemeHint", () => {
  it("accepts light and dark", () => {
    expect(readThemeHint("light\n")).toBe("light");
    expect(readThemeHint("dark")).toBe("dark");
  });

  it("rejects anything else", () => {
    expect(readThemeHint("e-pi-light")).toBeUndefined();
    expect(readThemeHint("")).toBeUndefined();
  });
});

describe("applyEpiTheme", () => {
  it("switches by Theme instance so settings.json stays on the auto pair", () => {
    const lightTheme = { name: "e-pi-light" };
    const ui = {
      getTheme: vi.fn((name: string) => (name === "e-pi-light" ? lightTheme : undefined)),
      setTheme: vi.fn(),
    };
    applyEpiTheme(ui, "light");
    expect(ui.getTheme).toHaveBeenCalledWith("e-pi-light");
    expect(ui.setTheme).toHaveBeenCalledWith(lightTheme);
  });

  it("falls back to the theme name when getTheme misses", () => {
    const ui = { getTheme: vi.fn(() => undefined), setTheme: vi.fn() };
    applyEpiTheme(ui, "dark");
    expect(ui.setTheme).toHaveBeenCalledWith("dark");
  });
});

describe("applyThemeFromHint", () => {
  it("applies a provided hint string without reading disk", () => {
    const ui = { getTheme: vi.fn(() => undefined), setTheme: vi.fn() };
    applyThemeFromHint(ui, "light");
    expect(ui.setTheme).toHaveBeenCalledWith("e-pi-light");
  });

  it("no-ops on a missing setTheme (test / degraded ctx.ui)", () => {
    expect(() => applyThemeFromHint({}, "light")).not.toThrow();
  });
});
