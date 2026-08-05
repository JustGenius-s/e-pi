import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let testAgentDir = "";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, getAgentDir: () => testAgentDir };
});

import { SettingsManager } from "@earendil-works/pi-coding-agent";

import { CommandService } from "../electron/main/services/command-service";

function writeTemplate(dir: string, name: string, body = "Do the thing."): string {
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${name}.md`);
  writeFileSync(filePath, body, "utf8");
  return filePath;
}

describe("CommandService", () => {
  let root: string;
  let cwd: string;
  let service: CommandService;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "e-pi-commands-"));
    testAgentDir = join(root, "pi-agent");
    service = new CommandService();
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "e-pi-command-cwd-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("always lists pi's built-in slash commands", async () => {
    const records = await service.list(cwd);
    const names = records.map((record) => record.name);
    for (const builtin of ["model", "settings", "compact", "resume", "quit"]) {
      expect(names).toContain(builtin);
    }
    for (const record of records.filter((item) => item.source === "builtin")) {
      expect(record.description).toBeTruthy();
    }
  });

  it("discovers prompt templates from the global and project dirs", async () => {
    writeTemplate(
      join(testAgentDir, "prompts"),
      "review",
      ["---", "description: Review staged git changes", "---", "Review the staged changes."].join("\n"),
    );
    writeTemplate(
      join(cwd, ".pi", "prompts"),
      "fix-bug",
      ["---", "description: Fix a bug", "argument-hint: <file>", "---", "Fix the bug in $1."].join("\n"),
    );

    const records = await service.list(cwd);
    const byName = new Map(records.map((record) => [record.name, record]));

    expect(byName.get("review")).toMatchObject({ source: "template", description: "Review staged git changes" });
    expect(byName.get("fix-bug")).toMatchObject({
      source: "template",
      description: "Fix a bug",
      argumentHint: "<file>",
    });
  });

  it("falls back to the first non-empty line for missing descriptions", async () => {
    writeTemplate(join(testAgentDir, "prompts"), "bare", "\n\nJust a bare template.\n\nWith more text.");

    const record = (await service.list(cwd)).find((item) => item.name === "bare");
    expect(record?.description).toBe("Just a bare template.");
  });

  it("loads templates from configured prompt paths (settings `prompts`)", async () => {
    const custom = mkdtempSync(join(tmpdir(), "e-pi-custom-prompts-"));
    try {
      writeTemplate(custom, "from-settings", "---\ndescription: From settings path\n---\nDo it.");

      const settings = SettingsManager.create(cwd, testAgentDir, { projectTrusted: true });
      settings.setPromptTemplatePaths([custom]);
      await settings.flush();

      const record = (await service.list(cwd)).find((item) => item.name === "from-settings");
      expect(record).toMatchObject({ source: "template", description: "From settings path" });
    } finally {
      rmSync(custom, { recursive: true, force: true });
    }
  });

  it("ignores non-markdown files and unreadable paths", async () => {
    const dir = join(testAgentDir, "prompts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.txt"), "not a template", "utf8");
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);

    const records = await service.list(cwd);
    expect(records.some((record) => record.name === "notes")).toBe(false);
  });

  it("discovers extension commands from configured extension paths", async () => {
    const extDir = mkdtempSync(join(tmpdir(), "e-pi-ext-commands-"));
    try {
      mkdirSync(extDir, { recursive: true });
      writeFileSync(
        join(extDir, "index.ts"),
        [
          'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
          "",
          "export default function (pi: ExtensionAPI): void {",
          '  pi.registerCommand("ext-hello", { description: "Hello from a plugin", handler: async () => {} });',
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const settings = SettingsManager.create(cwd, testAgentDir, { projectTrusted: true });
      settings.setExtensionPaths([extDir]);
      await settings.flush();

      const records = await service.list(cwd);
      const command = records.find((record) => record.name === "ext-hello");
      expect(command).toMatchObject({ source: "plugin", description: "Hello from a plugin" });
    } finally {
      rmSync(extDir, { recursive: true, force: true });
    }
  });

  it("keeps builtins and templates even when extension discovery fails", async () => {
    // A settings path pointing at a non-existent directory must not break the list.
    const settings = SettingsManager.create(cwd, testAgentDir, { projectTrusted: true });
    settings.setExtensionPaths([join(cwd, "does-not-exist")]);
    await settings.flush();

    const records = await service.list(cwd);
    expect(records.some((record) => record.name === "model")).toBe(true);
  });
});
