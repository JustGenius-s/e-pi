import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { shell } from "electron";
import { stringify } from "yaml";

import type {
  SkillAddPathRequest,
  SkillCreateRequest,
  SkillMutation,
  SkillRecord,
  SkillSetEnabledRequest,
  SkillSource,
} from "../../../src/types/contracts";
import { loadPiAgent } from "./pi-agent-loader";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * User skills shared across agent harnesses (also scanned by the pi CLI).
 * Resolved lazily so tests can redirect homedir().
 */
function userAgentsSkillsDir(): string {
  return resolve(homedir(), ".agents", "skills");
}

/** Nearest ancestor of `startDir` that contains a `.git` entry (dir or file). */
function findGitRepoRoot(startDir: string): string | undefined {
  let dir = startDir;
  while (true) {
    if (existsSync(resolve(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export class SkillService {
  async list(cwd: string): Promise<SkillRecord[]> {
    const { getAgentDir, loadSkills } = await loadPiAgent();
    const settings = await this.#settings(cwd);
    const userSkillsDir = resolve(getAgentDir(), "skills");
    const projectSkillsDir = resolve(cwd, ".pi", "skills");
    // Mirror the CLI's discovery: user skills also live in ~/.agents/skills,
    // and trusted projects contribute .agents/skills from cwd and ancestors
    // (up to the git repo root). loadSkills() has no knowledge of either.
    const projectAgentsSkillDirs = this.#projectAgentsSkillDirs(cwd).filter((dir) => dir !== userAgentsSkillsDir());
    const { skills } = loadSkills({
      cwd,
      agentDir: getAgentDir(),
      skillPaths: [...settings.getSkillPaths(), userAgentsSkillsDir(), ...projectAgentsSkillDirs],
      includeDefaults: true,
    });
    return (
      skills
        // ~/.agents/skills only yields skills from subdirectories — root-level
        // .md files are ignored there, per the CLI's discovery rules.
        .filter((skill) => dirname(skill.filePath) !== userAgentsSkillsDir())
        .map((skill) => this.#toRecord(skill, userSkillsDir, projectSkillsDir, projectAgentsSkillDirs))
        .sort((a, b) => a.name.localeCompare(b.name))
    );
  }

  /** `.agents/skills` in cwd and each ancestor up to the git repo root. */
  #projectAgentsSkillDirs(cwd: string): string[] {
    const dirs: string[] = [];
    const repoRoot = findGitRepoRoot(resolve(cwd));
    let dir = resolve(cwd);
    while (true) {
      dirs.push(resolve(dir, ".agents", "skills"));
      if (repoRoot && dir === repoRoot) break;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return dirs;
  }

  read(cwd: string, filePath: string): string {
    const resolved = resolve(filePath);
    if (!existsSync(resolved)) throw new Error("Skill file does not exist.");
    return readFileSync(resolved, "utf8");
  }

  async create(request: SkillCreateRequest): Promise<SkillRecord[]> {
    const name = request.name.trim();
    if (!SKILL_NAME_PATTERN.test(name)) {
      throw new Error(
        "Skill name must be lowercase letters, numbers, and hyphens only (no leading/trailing/consecutive hyphens).",
      );
    }
    const description = request.description.trim();
    if (!description) {
      throw new Error("Skill description is required.");
    }
    const { getAgentDir } = await loadPiAgent();
    const dir =
      request.scope === "project"
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
    const settings = await this.#settings(request.cwd);
    const existing =
      request.scope === "project"
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
    const { parseFrontmatter } = await loadPiAgent();
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
    const settings = await this.#settings(request.cwd);
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

  #toRecord(
    skill: {
      name: string;
      description: string;
      filePath: string;
      baseDir: string;
      sourceInfo: { scope: string };
      disableModelInvocation: boolean;
    },
    userSkillsDir: string,
    projectSkillsDir: string,
    projectAgentsSkillDirs: string[],
  ): SkillRecord {
    // Classify by location, not by loadSkills' sourceInfo: skills from
    // ~/.agents/skills arrive with scope "path" but are user-managed.
    const userDirs = [userSkillsDir, userAgentsSkillsDir()];
    const projectDirs = [projectSkillsDir, ...projectAgentsSkillDirs];
    const underUser = this.#isUnderAny(userDirs, skill.baseDir);
    const underProject = this.#isUnderAny(projectDirs, skill.baseDir);
    const source: SkillSource = underUser ? "user" : underProject ? "project" : "path";
    const managed = underUser || underProject;
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

  #isUnderAny(roots: string[], target: string): boolean {
    return roots.some((root) => this.#isUnder(root, target));
  }

  #isUnder(root: string, target: string): boolean {
    const normalizedRoot = resolve(root);
    const normalizedTarget = resolve(target);
    if (normalizedTarget === normalizedRoot) return true;
    const prefix = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`;
    return normalizedTarget.startsWith(prefix);
  }

  async #settings(cwd: string): Promise<SettingsManager> {
    const { SettingsManager, getAgentDir } = await loadPiAgent();
    return SettingsManager.create(cwd, getAgentDir(), { projectTrusted: true });
  }
}
