import { describe, expect, it } from "vitest";

import { compactTokenLabel, parseTokenInput, tokenPresetLabel } from "../src/lib/tokenPreset";

describe("parseTokenInput", () => {
  it("returns undefined for empty or invalid input", () => {
    expect(parseTokenInput("")).toBeUndefined();
    expect(parseTokenInput("   ")).toBeUndefined();
    expect(parseTokenInput("abc")).toBeUndefined();
    expect(parseTokenInput("0")).toBeUndefined();
    expect(parseTokenInput("-128000")).toBeUndefined();
    expect(parseTokenInput("128kb")).toBeUndefined();
  });

  it("parses integers and grouped digits", () => {
    expect(parseTokenInput("128000")).toBe(128000);
    expect(parseTokenInput(" 272000 ")).toBe(272000);
    expect(parseTokenInput("128,000")).toBe(128000);
    expect(parseTokenInput("128_000")).toBe(128000);
  });

  it("parses k/M suffixes", () => {
    expect(parseTokenInput("128k")).toBe(128000);
    expect(parseTokenInput("128K")).toBe(128000);
    expect(parseTokenInput("128 k")).toBe(128000);
    expect(parseTokenInput("1M")).toBe(1_000_000);
    expect(parseTokenInput("1.5M")).toBe(1_500_000);
    expect(parseTokenInput("2m")).toBe(2_000_000);
    expect(parseTokenInput("0.5k")).toBe(500);
  });

  it("rejects values above 1B tokens", () => {
    expect(parseTokenInput("1000000001")).toBeUndefined();
    expect(parseTokenInput("2000M")).toBeUndefined();
  });
});

describe("compactTokenLabel", () => {
  it("formats thousands and millions", () => {
    expect(compactTokenLabel(256)).toBe("256");
    expect(compactTokenLabel(8192)).toBe("8k");
    expect(compactTokenLabel(128000)).toBe("128k");
    expect(compactTokenLabel(1_000_000)).toBe("1M");
    expect(tokenPresetLabel(128000)).toBe("128k - 128000");
  });
});
