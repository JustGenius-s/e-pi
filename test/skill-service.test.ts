import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let testAgentDir = "";
let testHomeDir = "";

vi.mock("electron", () => ({
  shell: {
    trashItem: vi.fn(async (target: string) => {
      rmSync(target, { recursive: true, force: true });
    }),
  },
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, getAgentDir: () => testAgentDir };
});

// The service resolves the shared ~/.agents/skills from homedir().
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => testHomeDir };
});

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { SkillService } from "../electron/main/services/skill-service";

function writeSkill(dir: string, name: string, description: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8",
  );
}

describe("SkillService", () => {
  let root: string;
  let cwd: string;
  let service: SkillService;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "e-pi-skills-"));
    testAgentDir = join(root, "pi-agent");
    testHomeDir = join(root, "home");
    service = new SkillService();
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "e-pi-skill-cwd-"));
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

  describe("discovery", () => {
    let projectDir = "";

    beforeAll(() => {
      projectDir = join(root, "project");

      // ~/.pi/agent/skills (user, classic location)
      writeSkill(
        join(testAgentDir, "skills", "pi-user-skill"),
        "pi-user-skill",
        "from pi agent dir",
      );
      // ~/.agents/skills (user, shared across harnesses) + a root .md that must be ignored
      writeSkill(
        join(testHomeDir, ".agents", "skills", "agents-user-skill"),
        "agents-user-skill",
        "from ~/.agents/skills",
      );
      writeFileSync(join(testHomeDir, ".agents", "skills", "README.md"), "not a skill\n", "utf8");
      // Project: .pi/skills and .agents/skills (trusted project, git repo root at project/)
      mkdirSync(join(projectDir, ".git"), { recursive: true });
      writeSkill(
        join(projectDir, ".pi", "skills", "proj-pi-skill"),
        "proj-pi-skill",
        "from .pi/skills",
      );
      writeSkill(
        join(projectDir, ".agents", "skills", "proj-agents-skill"),
        "proj-agents-skill",
        "from project .agents/skills",
      );

      // Settings skill path: a directory outside the managed locations.
      const settings = SettingsManager.create(projectDir, testAgentDir, { projectTrusted: true });
      settings.setSkillPaths([join(root, "custom-skills")]);
      writeSkill(join(root, "custom-skills", "path-skill"), "path-skill", "from settings path");
      settings.flush();
    });

    it("discovers skills from all locations with correct sources", () => {
      const records = service.list(projectDir);
      const byName = new Map(records.map((record) => [record.name, record]));

      expect(records.map((record) => record.name).sort()).toEqual([
        "agents-user-skill",
        "path-skill",
        "pi-user-skill",
        "proj-agents-skill",
        "proj-pi-skill",
      ]);

      expect(byName.get("pi-user-skill")).toMatchObject({ source: "user", managed: true });
      expect(byName.get("agents-user-skill")).toMatchObject({ source: "user", managed: true });
      expect(byName.get("proj-pi-skill")).toMatchObject({ source: "project", managed: true });
      expect(byName.get("proj-agents-skill")).toMatchObject({ source: "project", managed: true });
      expect(byName.get("path-skill")).toMatchObject({ source: "path", managed: false });
    });

    it("ignores root-level .md files in ~/.agents/skills", () => {
      const names = service.list(projectDir).map((record) => record.name);
      expect(names).not.toContain("README");
    });

    it("keeps enabled/disabled from frontmatter", () => {
      writeSkill(join(testAgentDir, "skills", "disabled-skill"), "disabled-skill", "turned off");
      const filePath = join(testAgentDir, "skills", "disabled-skill", "SKILL.md");
      const content = readFileSync(filePath, "utf8");
      writeFileSync(
        filePath,
        content.replace("---\nname:", "---\ndisable-model-invocation: true\nname:"),
        "utf8",
      );
      const record = service.list(projectDir).find((item) => item.name === "disabled-skill");
      expect(record?.enabled).toBe(false);
    });
  });
});
