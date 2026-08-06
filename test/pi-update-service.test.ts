import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// The sandbox package dir replaces the real pnpm-store location so a test run
// never touches the working install. Both the service under test and this test
// read the override from the environment.
process.env.PI_PACKAGE_DIR = join(mkdtempSync(join(tmpdir(), "e-pi-pkg-")), "pi-coding-agent");

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
        const data = execFileSync("tar", ["-czf", "-", "-C", join(__dirname, "fixtures"), "package"]);
        return {
          ok: true,
          arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        } as Response;
      }
      throw new Error(`Unexpected URL: ${url}`);
    }),
  },
}));

import { vi } from "vitest";

import { applyPiUpdate, versionGt } from "../electron/main/services/pi-update-service";

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
  const root = join(__dirname, "fixtures");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "package", "dist"), { recursive: true });
  writeFileSync(join(root, "package", "package.json"), JSON.stringify(FIXTURE_PKG, null, 2));
  writeFileSync(join(root, "package", "dist", "cli.js"), "console.log('pi 0.84.0');\n");
  writeFileSync(join(root, "package", "index.js"), "export const VERSION = '0.84.0';\n");
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
  rmSync(join(__dirname, "fixtures"), { recursive: true, force: true });
  rmSync(process.env.PI_PACKAGE_DIR!, { recursive: true, force: true });
  rmSync(join(process.env.PI_PACKAGE_DIR!, ".."), { recursive: true, force: true });
});

describe("applyPiUpdate", () => {
  it("downloads, installs and atomically swaps the new pi version", async () => {
    writeFixture();
    writeOldInstall();

    const result = await applyPiUpdate();

    expect(result.from).toBe("0.83.0");
    expect(result.to).toBe("0.84.0");
    expect(result.path).toBe(process.env.PI_PACKAGE_DIR);
    // New version files are in place.
    expect(existsSync(join(process.env.PI_PACKAGE_DIR!, "dist", "cli.js"))).toBe(true);
    // The staged dependency (ms) was installed.
    expect(existsSync(join(process.env.PI_PACKAGE_DIR!, "node_modules", "ms", "package.json"))).toBe(true);
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
