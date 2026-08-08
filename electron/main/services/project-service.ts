import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { app } from "electron";

import type { CreateProjectRequest, Project, UpdateProjectRequest } from "../../../src/types/contracts";

/**
 * Multi-folder projects: a named group of source folders/repos with one
 * primary repo (the git/agent target). Sessions stay bound to their own cwd;
 * the project is a label + routing layer. Stored in userData (never inside a
 * project folder, which may be read-only) as a single JSON document, written
 * atomically so a crash can't corrupt the file.
 */
export class ProjectService {
  #projects: Project[] | undefined;
  #listeners = new Set<(projects: Project[]) => void>();
  #writeChain: Promise<void> = Promise.resolve();

  private filePath(): string {
    return join(app.getPath("userData"), "projects.json");
  }

  onUpdated(listener: (projects: Project[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async list(): Promise<Project[]> {
    await this.#ensureLoaded();
    return this.#projects!.map((project) => ({ ...project }));
  }

  /** The project whose folders contain `cwd`; undefined for implicit single-folder projects. */
  async resolve(cwd: string): Promise<Project | undefined> {
    await this.#ensureLoaded();
    const normalized = normalizePath(cwd);
    return this.#projects!.find((project) => project.folders.some((folder) => normalizePath(folder) === normalized));
  }

  /** Folders that actually contain a .git directory (review repo switcher). */
  gitRepos(folders: string[]): string[] {
    return folders.filter((folder) => existsSync(join(folder, ".git")));
  }

  async create(request: CreateProjectRequest): Promise<Project[]> {
    await this.#ensureLoaded();
    const folders = normalizeFolders(request.folders);
    const primaryRepo = folders.includes(normalizePath(request.primaryRepo)) ? request.primaryRepo : folders[0];
    if (!primaryRepo) throw new Error("A project needs at least one folder.");
    const project: Project = {
      id: randomUUID(),
      name: request.name?.trim() || undefined,
      folders,
      primaryRepo,
      createdAt: new Date().toISOString(),
    };
    this.#projects!.push(project);
    await this.#persist();
    return this.list();
  }

  async update(request: UpdateProjectRequest): Promise<Project[]> {
    await this.#ensureLoaded();
    const index = this.#projects!.findIndex((project) => project.id === request.id);
    if (index < 0) throw new Error("Project not found.");
    const current = this.#projects![index];
    const folders = request.folders ? normalizeFolders(request.folders) : current.folders;
    const primaryRepo = request.primaryRepo
      ? folders.includes(normalizePath(request.primaryRepo))
        ? request.primaryRepo
        : folders[0]
      : current.primaryRepo;
    this.#projects![index] = {
      ...current,
      name: request.name?.trim() || undefined,
      folders,
      primaryRepo,
    };
    await this.#persist();
    return this.list();
  }

  async remove(id: string): Promise<Project[]> {
    await this.#ensureLoaded();
    this.#projects! = this.#projects!.filter((project) => project.id !== id);
    await this.#persist();
    return this.list();
  }

  /** Load once, then keep in memory; the file is only ever written by us. */
  async #ensureLoaded(): Promise<void> {
    if (this.#projects) return;
    try {
      const raw = await readFile(this.filePath(), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      this.#projects = Array.isArray(parsed) ? (parsed as Project[]) : [];
    } catch {
      this.#projects = [];
    }
  }

  /** Serialized writes; the temp-then-rename swap keeps the file valid on crash. */
  #persist(): Promise<void> {
    const snapshot = JSON.stringify(this.#projects, null, 2);
    this.#writeChain = this.#writeChain.then(async () => {
      const target = this.filePath();
      await mkdir(dirname(target), { recursive: true });
      const tmp = `${target}.tmp`;
      await writeFile(tmp, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(tmp, target);
      const copy = this.#projects!.map((project) => ({ ...project }));
      for (const listener of this.#listeners) listener(copy);
    });
    return this.#writeChain;
  }
}

function normalizePath(path: string): string {
  return path.replace(/\/+$/, "");
}

function normalizeFolders(folders: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const folder of folders) {
    const normalized = normalizePath(folder);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(folder);
  }
  return result;
}
