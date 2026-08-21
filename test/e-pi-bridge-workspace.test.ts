import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { clipDialogKeepingActions, dialogMaxHeight, PROJECTS_FILE_NAME } from "../resources/e-pi-bridge";
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
      JSON.stringify([{ id: "p1", name: "proto&nest", folders: [PROJECT_A, PROJECT_B], primaryRepo: PROJECT_A }]),
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

describe("e-pi bridge custom dialog height cap", () => {
  it("reserves transcript rows so a dialog cannot fill the terminal", () => {
    expect(dialogMaxHeight(36)).toBe(22);
    expect(dialogMaxHeight(36)).toBeLessThan(36);
    expect(dialogMaxHeight(10)).toBeGreaterThanOrEqual(1);
    expect(dialogMaxHeight(10)).toBeLessThan(10);
  });

  it("keeps the title and the action rows when the command preview is huge", () => {
    const lines = [
      "Permission Required",
      ...Array.from({ length: 80 }, (_, i) => `command-line-${i}`),
      "",
      "▶ (y) Yes",
      "  (s) Yes, for this session",
      "  (n) No",
      "  (r) No, provide reason",
      "",
      "↑/↓ move · enter confirm",
    ];
    const clipped = clipDialogKeepingActions(lines, 16);
    expect(clipped.length).toBe(16);
    expect(clipped[0]).toBe("Permission Required");
    expect(clipped).toContain("…");
    expect(clipped.at(-1)).toBe("↑/↓ move · enter confirm");
    expect(clipped).toContain("▶ (y) Yes");
    expect(clipped).toContain("  (n) No");
    expect(clipped).not.toContain("command-line-40");
  });

  it("leaves short dialogs unchanged", () => {
    const lines = ["Permission Required", "Allow ls?", "▶ (y) Yes"];
    expect(clipDialogKeepingActions(lines, 16)).toEqual(lines);
  });

  it("session_start wraps ctx.ui.custom so a tall dialog is capped", async () => {
    const { handlers } = loadBridge();
    const sessionStart = handlers.get("session_start")!;
    const originalCustom = vi.fn(
      async (
        factory: (
          tui: { terminal: { rows: number } },
          theme: unknown,
          keybindings: unknown,
          done: (result: unknown) => void,
        ) => { render: (width: number) => string[]; invalidate: () => void; handleInput?: (data: string) => void },
      ) => {
        const tui = { terminal: { rows: 36 } };
        const component = factory(tui, {}, {}, () => undefined);
        return component.render(80);
      },
    );
    const ctx = {
      model: undefined,
      thinkingLevel: "off",
      getContextUsage: () => undefined,
      sessionManager: {
        getEntries: () => [],
        getSessionFile: () => undefined,
      },
      ui: {
        custom: originalCustom,
        setHeader: vi.fn(),
        setFooter: vi.fn(),
        setEditorComponent: vi.fn(),
      },
    };
    sessionStart({}, ctx);
    expect(ctx.ui.custom).not.toBe(originalCustom);

    const rendered = (await ctx.ui.custom((_tui, _theme, _keys, _done) => ({
      render: () => [
        "Permission Required",
        ...Array.from({ length: 80 }, (_, i) => `command-line-${i}`),
        "",
        "▶ (y) Yes",
        "  (n) No",
        "",
        "enter confirm",
      ],
      invalidate: () => undefined,
      handleInput: () => undefined,
    }))) as string[];
    expect(rendered.length).toBe(dialogMaxHeight(36));
    expect(rendered[0]).toBe("Permission Required");
    expect(rendered.at(-1)).toBe("enter confirm");
    expect(rendered).toContain("▶ (y) Yes");
  });
});
