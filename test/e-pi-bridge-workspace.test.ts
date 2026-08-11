import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { PROJECTS_FILE_NAME } from "../resources/e-pi-bridge";
import ePiBridge from "../resources/e-pi-bridge";

/**
 * Wiring test: the bridge must register the `project_repos` tool and a
 * `before_agent_start` handler that appends the workspace note to the system
 * prompt when the session's cwd belongs to a multi-repo project.
 */
function loadBridge() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const pi = {
    registerTool: vi.fn((tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
      tools.push(tool);
    }),
    registerCommand: vi.fn(),
    setThinkingLevel: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, handler);
    }),
    events: { on: vi.fn() },
  } as never;
  ePiBridge(pi as never);
  return { handlers, tools };
}

const PROJECT_A = "/work/project-a";
const PROJECT_B = "/work/project-b";

describe("e-pi bridge project workspace wiring", () => {
  const dir = mkdtempSync(join(tmpdir(), "epi-bridge-wiring-"));
  const projectsFile = join(dir, PROJECTS_FILE_NAME);
  const prevEnv = process.env.E_PI_USER_DATA;

  afterAll(() => {
    if (prevEnv === undefined) delete process.env.E_PI_USER_DATA;
    else process.env.E_PI_USER_DATA = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers the project_repos tool", () => {
    const { tools } = loadBridge();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("project_repos");
  });

  it("before_agent_start appends the workspace note for multi-repo projects", async () => {
    process.env.E_PI_USER_DATA = dir;
    writeFileSync(
      projectsFile,
      JSON.stringify([
        { id: "p1", name: "proto&nest", folders: [PROJECT_A, PROJECT_B], primaryRepo: PROJECT_A },
      ]),
    );
    const { handlers } = loadBridge();
    const beforeAgentStart = handlers.get("before_agent_start")!;

    const systemPrompt = "Base system prompt";
    const result = (await beforeAgentStart({
      systemPrompt,
      systemPromptOptions: { cwd: PROJECT_A },
    })) as { systemPrompt?: string } | undefined;

    expect(result?.systemPrompt).toBeDefined();
    expect(result!.systemPrompt!.startsWith(systemPrompt)).toBe(true);
    expect(result!.systemPrompt).toContain(PROJECT_B);
    expect(result!.systemPrompt).toContain("project_repos");
  });

  it("before_agent_start leaves the prompt untouched outside a project", async () => {
    process.env.E_PI_USER_DATA = dir;
    writeFileSync(projectsFile, JSON.stringify([{ id: "p1", folders: [PROJECT_A], primaryRepo: PROJECT_A }]));
    const { handlers } = loadBridge();
    const beforeAgentStart = handlers.get("before_agent_start")!;

    const result = await beforeAgentStart({ systemPrompt: "Base", systemPromptOptions: { cwd: PROJECT_A } });
    expect(result).toBeUndefined();
  });
});
