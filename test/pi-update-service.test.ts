import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

// The sandbox package dir replaces the real pnpm-store location so a test run
// never touches the working install. Both the service under test and this test
// read the override from the environment.
const packageRoot = mkdtempSync(join(tmpdir(), "e-pi-pkg-"));
const fixtureRoot = mkdtempSync(join(tmpdir(), "e-pi-update-fixture-"));
process.env.PI_PACKAGE_DIR = join(packageRoot, "pi-coding-agent");
process.env.E_PI_UPDATE_FIXTURE_ROOT = fixtureRoot;

// The service imports electron's `net` at module load, so stub the whole
// module before importing it.
vi.mock("electron", () => ({
  net: {
    fetch: vi.fn(async (url: string) => {
      const encoded = encodeURIComponent("latest");
      if (url.includes(`${encoded}`) && url.includes("/latest")) {
        return { ok: true, json: async () => ({ version: "0.84.0" }) } as Response;
      }
      if (url.endsWith("0.84.0.tgz")) {
        const { execFileSync } = await import("node:child_process");
        const root = process.env.E_PI_UPDATE_FIXTURE_ROOT;
        if (!root) throw new Error("Missing update fixture root.");
        const data = execFileSync("tar", ["-czf", "-", "-C", root, "package"]);
        return {
          ok: true,
          arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        } as Response;
      }
      throw new Error(`Unexpected URL: ${url}`);
    }),
  },
}));

vi.mock("../electron/main/services/pi-compatibility-service", () => ({
  applyPiCompatibilityPatches: vi.fn(),
}));

import { vi } from "vitest";

import { applyPiCompatibilityPatches } from "../electron/main/services/pi-compatibility-service";
import {
  applyPiUpdate,
  PI_COMPATIBILITY_REQUIRED_PREFIX,
  resetPiUpdateCacheForTests,
  versionGt,
} from "../electron/main/services/pi-update-service";

/** Minimal fixture package that mimics the registry tarball layout. */
const FIXTURE_PKG = {
  name: "@earendil-works/pi-coding-agent",
  version: "0.84.0",
  type: "module",
  dependencies: {
    ms: "2.1.3",
  },
  devDependencies: {
    vitest: "4.1.9",
  },
  scripts: {
    test: "vitest run",
  },
};

function writeFixture(): void {
  const packageDir = join(fixtureRoot, "package");
  rmSync(packageDir, { recursive: true, force: true });
  mkdirSync(join(packageDir, "dist"), { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify(FIXTURE_PKG, null, 2));
  writeFileSync(join(packageDir, "dist", "cli.js"), "console.log('pi 0.84.0');\n");
  writeFileSync(join(packageDir, "index.js"), "export const VERSION = '0.84.0';\n");
}

/** Simulate the previously bundled install (0.83.0) inside the sandbox dir. */
function writeOldInstall(): void {
  const pkgDir = process.env.PI_PACKAGE_DIR!;
  rmSync(pkgDir, { recursive: true, force: true });
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.83.0", type: "module" }, null, 2),
  );
  writeFileSync(join(pkgDir, "index.js"), "export const VERSION = '0.83.0';\n");
}

afterEach(() => {
  vi.clearAllMocks();
  resetPiUpdateCacheForTests();
  rmSync(join(fixtureRoot, "package"), { recursive: true, force: true });
  rmSync(process.env.PI_PACKAGE_DIR!, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(packageRoot, { recursive: true, force: true });
  rmSync(fixtureRoot, { recursive: true, force: true });
  delete process.env.PI_PACKAGE_DIR;
  delete process.env.E_PI_UPDATE_FIXTURE_ROOT;
});

describe("applyPiUpdate", () => {
  it("keeps the previous install when the compatibility layer rejects an update", async () => {
    writeFixture();
    writeOldInstall();
    vi.mocked(applyPiCompatibilityPatches).mockImplementationOnce(() => {
      throw new Error("compatibility conflict");
    });

    await expect(applyPiUpdate()).rejects.toThrow(PI_COMPATIBILITY_REQUIRED_PREFIX);

    const installed = JSON.parse(readFileSync(join(process.env.PI_PACKAGE_DIR!, "package.json"), "utf8")) as {
      version: string;
    };
    expect(installed.version).toBe("0.83.0");
  });

  it("installs stock pi-tui only after an explicit compatibility fallback", async () => {
    writeFixture();
    writeOldInstall();
    vi.mocked(applyPiCompatibilityPatches).mockImplementationOnce(() => {
      throw new Error("compatibility conflict");
    });

    const result = await applyPiUpdate({ allowStockFallback: true });

    expect(result).toMatchObject({ from: "0.83.0", to: "0.84.0", fallbackToStock: true });
    expect(applyPiCompatibilityPatches).toHaveBeenCalledOnce();
    const installed = JSON.parse(readFileSync(join(process.env.PI_PACKAGE_DIR!, "package.json"), "utf8")) as {
      version: string;
    };
    expect(installed.version).toBe("0.84.0");
  });

  it("installs stock pi-tui without invoking the patch when optimizations are disabled", async () => {
    writeFixture();
    writeOldInstall();

    const result = await applyPiUpdate({ tuiOptimizationsEnabled: false });

    expect(result.from).toBe("0.83.0");
    expect(result.to).toBe("0.84.0");
    expect(result.path).toBe(process.env.PI_PACKAGE_DIR);
    // New version files are in place.
    expect(existsSync(join(process.env.PI_PACKAGE_DIR!, "dist", "cli.js"))).toBe(true);
    // The staged dependency (ms) was installed.
    expect(existsSync(join(process.env.PI_PACKAGE_DIR!, "node_modules", "ms", "package.json"))).toBe(true);
    expect(applyPiCompatibilityPatches).not.toHaveBeenCalled();
    // No leftover backup directory.
    const parent = join(process.env.PI_PACKAGE_DIR!, "..");
    const leftovers = readdirSync(parent).filter((name: string) => name.includes(".old-"));
    expect(leftovers).toEqual([]);
  });
});

describe("versionGt", () => {
  it("compares equal versions", () => {
    expect(versionGt("0.83.0", "0.83.0")).toBe(false);
    expect(versionGt("0.83.0", "0.83.0.0")).toBe(false);
  });

  it("compares patch, minor and major bumps", () => {
    expect(versionGt("0.84.0", "0.83.0")).toBe(true);
    expect(versionGt("1.0.0", "0.99.0")).toBe(true);
    expect(versionGt("0.83.1", "0.83.0")).toBe(true);
    expect(versionGt("0.83.0", "0.84.0")).toBe(false);
  });

  it("treats missing segments as zero", () => {
    expect(versionGt("0.84", "0.83.5")).toBe(true);
    expect(versionGt("0.83.1", "0.83")).toBe(true);
    expect(versionGt("0.83", "0.83.1")).toBe(false);
  });
});
