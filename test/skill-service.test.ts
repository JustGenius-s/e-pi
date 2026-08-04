import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  shell: {
    trashItem: vi.fn(async (target: string) => {
      rmSync(target, { recursive: true, force: true });
    }),
  },
}));

import { SkillService } from "../electron/main/services/skill-service";

describe("SkillService", () => {
  let cwd: string;
  let service: SkillService;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "e-pi-skills-"));
    service = new SkillService();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("creates a project skill with a SKILL.md and lists it", async () => {
    const list = await service.create({
      cwd,
      scope: "project",
      name: "my-skill",
      description: "Does things.",
    });

    const skill = list.find((item) => item.name === "my-skill");
    expect(skill).toBeDefined();
    expect(skill?.source).toBe("project");
    expect(skill?.managed).toBe(true);
    expect(skill?.enabled).toBe(true);

    const filePath = skill!.filePath;
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, "utf8");
    expect(content).toContain("name: my-skill");
    expect(content).toContain("description: Does things.");
  });

  it("rejects invalid skill names", async () => {
    await expect(
      service.create({ cwd, scope: "project", name: "My Skill!", description: "Nope." }),
    ).rejects.toThrow(/lowercase/);
    await expect(
      service.create({ cwd, scope: "project", name: "-leading", description: "Nope." }),
    ).rejects.toThrow(/lowercase/);
  });

  it("disables and re-enables a skill via frontmatter", async () => {
    let list = await service.create({
      cwd,
      scope: "project",
      name: "toggle-skill",
      description: "Toggle me.",
    });
    const filePath = list.find((item) => item.name === "toggle-skill")!.filePath;

    list = await service.setEnabled({ cwd, filePath, enabled: false });
    expect(list.find((item) => item.filePath === filePath)?.enabled).toBe(false);
    expect(readFileSync(filePath, "utf8")).toContain("disable-model-invocation: true");

    list = await service.setEnabled({ cwd, filePath, enabled: true });
    expect(list.find((item) => item.filePath === filePath)?.enabled).toBe(true);
    expect(readFileSync(filePath, "utf8")).not.toContain("disable-model-invocation");
  });

  it("reads SKILL.md content", async () => {
    await service.create({ cwd, scope: "project", name: "readable", description: "Read me." });
    const list = service.list(cwd);
    const skill = list.find((item) => item.name === "readable")!;
    const content = service.read(cwd, skill.filePath);
    expect(content).toContain("# readable");
  });

  it("adds an external skill path and removes it via settings", async () => {
    const external = mkdtempSync(join(tmpdir(), "e-pi-external-"));
    mkdirSync(join(external, "extra-skill"), { recursive: true });
    writeFileSync(
      join(external, "extra-skill", "SKILL.md"),
      "---\nname: extra-skill\ndescription: From a custom path.\n---\n\n# Extra\n",
    );
    try {
      let list = await service.addPath({ cwd, scope: "project", path: external });
      expect(list.some((item) => item.name === "extra-skill")).toBe(true);
      const extra = list.find((item) => item.name === "extra-skill")!;
      expect(extra.source).toBe("path");
      expect(extra.managed).toBe(false);

      const { shell } = await import("electron");
      list = await service.remove({ cwd, filePath: extra.filePath });
      expect(shell.trashItem).toHaveBeenCalledWith(resolve(extra.baseDir));
      expect(list.some((item) => item.name === "extra-skill")).toBe(false);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });

  it("removes a managed skill directory to the trash", async () => {
    let list = await service.create({ cwd, scope: "project", name: "doomed", description: "Bye." });
    const filePath = list.find((item) => item.name === "doomed")!.filePath;

    const { shell } = await import("electron");
    list = await service.remove({ cwd, filePath });
    expect(shell.trashItem).toHaveBeenCalledWith(resolve(dirname(filePath)));
    expect(list.some((item) => item.name === "doomed")).toBe(false);
  });
});
