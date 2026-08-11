import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  PROJECTS_FILE_NAME,
  buildWorkspaceNote,
  findProjectForCwd,
  loadProjectWorkspace,
  normalizeWorkspacePath,
  parseProjects,
  type WorkspaceProject,
} from "../resources/e-pi-bridge";

const PROJECT_A = "/work/project-a";
const PROJECT_B = "/work/project-b";
const PROJECT_C = "/work/project-c";

const MULTI_REPO: WorkspaceProject = {
  id: "p1",
  name: "proto&nest",
  folders: [PROJECT_A, PROJECT_B],
  primaryRepo: PROJECT_A,
};

const SINGLE_REPO: WorkspaceProject = {
  id: "p2",
  name: "skills-hub",
  folders: [PROJECT_C],
  primaryRepo: PROJECT_C,
};

describe("parseProjects", () => {
  it("parses a valid project registry", () => {
    expect(parseProjects(JSON.stringify([MULTI_REPO]))).toEqual([MULTI_REPO]);
  });

  it("returns [] for invalid JSON", () => {
    expect(parseProjects("not json")).toEqual([]);
  });

  it("returns [] for non-array JSON", () => {
    expect(parseProjects('{"folders": []}')).toEqual([]);
  });
});

describe("findProjectForCwd", () => {
  it("finds the project whose folder matches cwd", () => {
    expect(findProjectForCwd([MULTI_REPO, SINGLE_REPO], PROJECT_B)).toBe(MULTI_REPO);
  });

  it("tolerates trailing slashes", () => {
    expect(findProjectForCwd([MULTI_REPO], `${PROJECT_B}/`)).toBe(MULTI_REPO);
  });

  it("returns undefined for a cwd outside every project", () => {
    expect(findProjectForCwd([MULTI_REPO], "/elsewhere/repo")).toBeUndefined();
  });

  it("returns undefined for an empty registry", () => {
    expect(findProjectForCwd([], PROJECT_A)).toBeUndefined();
  });
});

describe("normalizeWorkspacePath", () => {
  it("strips trailing slashes only", () => {
    expect(normalizeWorkspacePath("/a/b///")).toBe("/a/b");
    expect(normalizeWorkspacePath("/a/b")).toBe("/a/b");
  });
});

describe("buildWorkspaceNote", () => {
  it("returns undefined for a single-repo project (no noise)", () => {
    expect(buildWorkspaceNote(SINGLE_REPO, PROJECT_C)).toBeUndefined();
  });

  it("returns undefined when cwd belongs to no project", () => {
    expect(buildWorkspaceNote(undefined, PROJECT_A)).toBeUndefined();
  });

  it("lists every repo with current-session and primary markers", () => {
    const note = buildWorkspaceNote(MULTI_REPO, PROJECT_B)!;
    expect(note).toContain('multi-repo project "proto&nest"');
    expect(note).toContain(`- ${PROJECT_A} (primary)`);
    expect(note).toContain(`- ${PROJECT_B} (current session)`);
    expect(note).toContain("Call project_repos");
  });

  it("marks the current repo as primary when they coincide", () => {
    const note = buildWorkspaceNote(MULTI_REPO, PROJECT_A)!;
    expect(note).toContain(`- ${PROJECT_A} (current session, primary)`);
  });
});

describe("loadProjectWorkspace", () => {
  const dir = mkdtempSync(join(tmpdir(), "epi-workspace-test-"));
  const projectsFile = join(dir, PROJECTS_FILE_NAME);
  const prevEnv = process.env.E_PI_USER_DATA;

  afterAll(() => {
    if (prevEnv === undefined) delete process.env.E_PI_USER_DATA;
    else process.env.E_PI_USER_DATA = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns nothing when E_PI_USER_DATA is unset (standalone pi)", async () => {
    delete process.env.E_PI_USER_DATA;
    await expect(loadProjectWorkspace(PROJECT_A)).resolves.toEqual({ project: undefined, note: undefined });
  });

  it("reflects an editor edit: adding a repo folder changes the note on the next load", async () => {
    process.env.E_PI_USER_DATA = dir;

    // Editor state 1: single-repo project → no note.
    writeFileSync(projectsFile, JSON.stringify([{ ...SINGLE_REPO, folders: [PROJECT_A] }]));
    let result = await loadProjectWorkspace(PROJECT_A);
    expect(result.project?.folders).toEqual([PROJECT_A]);
    expect(result.note).toBeUndefined();

    // Editor state 2: repo B added to the project → the very next load carries
    // the workspace note naming both repos. No new session required.
    writeFileSync(projectsFile, JSON.stringify([{ ...MULTI_REPO, name: "proto&nest" }]));
    result = await loadProjectWorkspace(PROJECT_A);
    expect(result.project?.folders).toEqual([PROJECT_A, PROJECT_B]);
    expect(result.note).toContain(`- ${PROJECT_B}`);

    // Editor state 3: repo B removed again → note disappears.
    writeFileSync(projectsFile, JSON.stringify([{ ...SINGLE_REPO, folders: [PROJECT_A] }]));
    result = await loadProjectWorkspace(PROJECT_A);
    expect(result.note).toBeUndefined();
  });

  it("handles a missing/corrupt registry without throwing", async () => {
    process.env.E_PI_USER_DATA = dir;
    writeFileSync(projectsFile, "{broken");
    await expect(loadProjectWorkspace(PROJECT_A)).resolves.toEqual({ project: undefined, note: undefined });
  });
});
