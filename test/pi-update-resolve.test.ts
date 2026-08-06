import { describe, expect, it } from "vitest";

import { resolvePiPackageDir } from "../electron/main/services/pi-update-service";

/**
 * Verifies the package-dir resolver walks up from the entry file to the
 * package root (regression test: it used to return .../pi-coding-agent/dist,
 * which made the in-place update overwrite the wrong directory).
 */
describe("resolvePiPackageDir (real environment)", () => {
  it("resolves to the package root, not dist/", () => {
    delete process.env.PI_PACKAGE_DIR;
    const dir = resolvePiPackageDir();
    expect(dir.endsWith("/dist")).toBe(false);
    expect(dir.endsWith(`${"@earendil-works"}${"/pi-coding-agent"}`)).toBe(true);
    // The package.json that names this package must sit directly in the dir.
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const pkg = JSON.parse(readFileSync(`${dir}/package.json`, "utf8")) as { name?: string };
    expect(pkg.name).toBe("@earendil-works/pi-coding-agent");
  });
});
