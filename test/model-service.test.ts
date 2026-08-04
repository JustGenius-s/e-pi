import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let testAgentDir = "";
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, getAgentDir: () => testAgentDir };
});

import { ModelService } from "../electron/main/services/model-service";

describe("ModelService custom providers", () => {
  let service: ModelService;

  beforeAll(() => {
    testAgentDir = mkdtempSync(join(tmpdir(), "e-pi-models-"));
  });

  afterAll(() => {
    rmSync(testAgentDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    service = new ModelService();
    // Reset models.json between tests.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(testAgentDir, "models.json"), "{}\n", "utf8");
  });

  it("lists no custom providers for an empty models.json", async () => {
    expect(await service.listCustomProviders()).toEqual([]);
  });

  it("saves a custom provider and lists it back", async () => {
    const list = await service.saveCustomProvider({
      provider: {
        id: "my-gateway",
        name: "My Gateway",
        baseUrl: "https://api.example.com/v1",
        api: "openai-completions",
        apiKey: "$MY_API_KEY",
        models: [{ id: "my-model", name: "My Model", contextWindow: 128000, maxTokens: 4096 }],
      },
    });

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "my-gateway",
      name: "My Gateway",
      baseUrl: "https://api.example.com/v1",
      api: "openai-completions",
      apiKey: "$MY_API_KEY",
    });
    expect(list[0].models[0]).toMatchObject({
      id: "my-model",
      contextWindow: 128000,
      maxTokens: 4096,
    });

    const raw = JSON.parse(readFileSync(join(testAgentDir, "models.json"), "utf8"));
    expect(raw.providers["my-gateway"].baseUrl).toBe("https://api.example.com/v1");
  });

  it("upserts an existing provider id", async () => {
    await service.saveCustomProvider({
      provider: {
        id: "gw",
        baseUrl: "https://one.example.com/v1",
        api: "openai-completions",
        models: [],
      },
    });
    const list = await service.saveCustomProvider({
      provider: {
        id: "gw",
        name: "Renamed",
        baseUrl: "https://two.example.com/v1",
        api: "openai-completions",
        models: [],
      },
    });

    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Renamed");
    expect(list[0].baseUrl).toBe("https://two.example.com/v1");
  });

  it("preserves other providers when removing one", async () => {
    await service.saveCustomProvider({
      provider: {
        id: "a",
        baseUrl: "https://a.example.com/v1",
        api: "openai-completions",
        models: [],
      },
    });
    await service.saveCustomProvider({
      provider: {
        id: "b",
        baseUrl: "https://b.example.com/v1",
        api: "openai-completions",
        models: [],
      },
    });

    const list = await service.removeCustomProvider({ providerId: "a" });
    expect(list.map((item) => item.id)).toEqual(["b"]);

    const raw = JSON.parse(readFileSync(join(testAgentDir, "models.json"), "utf8"));
    expect(raw.providers.a).toBeUndefined();
    expect(raw.providers.b).toBeDefined();
  });

  it("reads a models.json with comments", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(testAgentDir, "models.json"),
      [
        "{",
        "  // user-managed providers",
        '  "providers": {',
        '    "commented": { "baseUrl": "https://x.example.com/v1", "api": "openai-completions" }',
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    const list = await service.listCustomProviders();
    expect(list.map((item) => item.id)).toEqual(["commented"]);
  });

  it("rejects invalid provider ids and missing base URLs", async () => {
    await expect(
      service.saveCustomProvider({
        provider: {
          id: "Bad ID!",
          baseUrl: "https://x.example.com/v1",
          api: "openai-completions",
          models: [],
        },
      }),
    ).rejects.toThrow(/lowercase/);

    await expect(
      service.saveCustomProvider({
        provider: { id: "ok", baseUrl: "  ", api: "openai-completions", models: [] },
      }),
    ).rejects.toThrow(/Base URL/);

    await expect(service.removeCustomProvider({ providerId: "missing" })).rejects.toThrow(/Unknown/);
  });
});
