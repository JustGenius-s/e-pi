import { shell } from "electron";
import { basename, dirname, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  getAgentDir,
  loadSkills,
  parseFrontmatter,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { stringify } from "yaml";
import type {
  SkillAddPathRequest,
  SkillCreateRequest,
  SkillMutation,
  SkillRecord,
  SkillSetEnabledRequest,
  SkillSource,
} from "../../../src/types/contracts";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class SkillService {
  list(cwd: string): SkillRecord[] {
    const settings = this.#settings(cwd);
    const userSkillsDir = resolve(getAgentDir(), "skills");
    const projectSkillsDir = resolve(cwd, ".pi", "skills");
    const { skills } = loadSkills({
      cwd,
      agentDir: getAgentDir(),
      skillPaths: settings.getSkillPaths(),
      includeDefaults: true,
    });
    return skills
      .map((skill) => this.#toRecord(skill, userSkillsDir, projectSkillsDir))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  read(cwd: string, filePath: string): string {
    const resolved = resolve(filePath);
    if (!existsSync(resolved)) throw new Error("Skill file does not exist.");
    return readFileSync(resolved, "utf8");
  }

  async create(request: SkillCreateRequest): Promise<SkillRecord[]> {
    const name = request.name.trim();
    if (!SKILL_NAME_PATTERN.test(name)) {
      throw new Error("Skill name must be lowercase letters, numbers, and hyphens only (no leading/trailing/consecutive hyphens).");
    }
    const description = request.description.trim();
    if (!description) {
      throw new Error("Skill description is required.");
    }
    const dir = request.scope === "project"
      ? resolve(request.cwd, ".pi", "skills", name)
      : resolve(getAgentDir(), "skills", name);
    if (existsSync(dir)) {
      throw new Error(`A skill named "${name}" already exists.`);
    }
    mkdirSync(dir, { recursive: true });
    const content = [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "---",
      "",
      `# ${name}`,
      "",
      "Describe what this skill does and when to use it.",
      "",
    ].join("\n");
    writeFileSync(resolve(dir, "SKILL.md"), content, "utf8");
    return this.list(request.cwd);
  }

  async addPath(request: SkillAddPathRequest): Promise<SkillRecord[]> {
    const path = resolve(request.path);
    if (!existsSync(path)) throw new Error("Path does not exist.");
    const settings = this.#settings(request.cwd);
    const existing = request.scope === "project"
      ? (settings.getProjectSettings().skills ?? [])
      : (settings.getGlobalSettings().skills ?? []);
    if (existing.includes(path)) return this.list(request.cwd);
    const next = [...existing, path];
    if (request.scope === "project") {
      settings.setProjectSkillPaths(next);
    } else {
      settings.setSkillPaths(next);
    }
    await settings.flush();
    return this.list(request.cwd);
  }

  async setEnabled(request: SkillSetEnabledRequest): Promise<SkillRecord[]> {
    const filePath = resolve(request.filePath);
    if (!existsSync(filePath)) throw new Error("Skill file does not exist.");
    const content = readFileSync(filePath, "utf8");
    const { frontmatter, body } = parseFrontmatter(content);
    if (request.enabled) {
      delete frontmatter["disable-model-invocation"];
    } else {
      frontmatter["disable-model-invocation"] = true;
    }
    const yamlString = stringify(frontmatter).trimEnd();
    const rewritten = `---\n${yamlString}\n---\n\n${body.trimStart()}\n`;
    writeFileSync(filePath, rewritten, "utf8");
    return this.list(request.cwd);
  }

  async remove(request: SkillMutation): Promise<SkillRecord[]> {
    const filePath = resolve(request.filePath);
    if (!existsSync(filePath)) throw new Error("Skill file does not exist.");
    const settings = this.#settings(request.cwd);
    this.#removeMatchingSkillPaths(settings, request.cwd, filePath);
    await settings.flush();
    // Move the owning directory (or the standalone markdown file) to the Trash.
    const target = basename(filePath) === "SKILL.md" ? dirname(filePath) : filePath;
    await shell.trashItem(resolve(target));
    return this.list(request.cwd);
  }

  #removeMatchingSkillPaths(settings: SettingsManager, cwd: string, filePath: string): void {
    const removeFrom = (paths: string[] | undefined): string[] | undefined => {
      if (!paths || paths.length === 0) return undefined;
      const filtered = paths.filter((path) => {
        const resolved = resolve(cwd, path);
        return resolved !== filePath && resolved !== dirname(filePath);
      });
      return filtered.length === paths.length ? undefined : filtered;
    };
    const globalPaths = removeFrom(settings.getGlobalSettings().skills);
    const projectPaths = removeFrom(settings.getProjectSettings().skills);
    if (globalPaths) settings.setSkillPaths(globalPaths);
    if (projectPaths) settings.setProjectSkillPaths(projectPaths);
  }

  #toRecord(skill: { name: string; description: string; filePath: string; baseDir: string; sourceInfo: { scope: string }; disableModelInvocation: boolean }, userSkillsDir: string, projectSkillsDir: string): SkillRecord {
    const source: SkillSource = skill.sourceInfo.scope === "project" ? "project" : skill.sourceInfo.scope === "user" ? "user" : "path";
    const managed = this.#isUnder(userSkillsDir, skill.baseDir) || this.#isUnder(projectSkillsDir, skill.baseDir);
    return {
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      baseDir: skill.baseDir,
      source,
      enabled: !skill.disableModelInvocation,
      managed,
    };
  }

  #isUnder(root: string, target: string): boolean {
    const normalizedRoot = resolve(root);
    const normalizedTarget = resolve(target);
    if (normalizedTarget === normalizedRoot) return true;
    const prefix = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`;
    return normalizedTarget.startsWith(prefix);
  }

  #settings(cwd: string): SettingsManager {
    return SettingsManager.create(cwd, getAgentDir(), { projectTrusted: true });
  }
}
