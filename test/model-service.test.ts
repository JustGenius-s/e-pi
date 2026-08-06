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
        id: "",
        name: "gw",
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
        id: "",
        name: "a",
        baseUrl: "https://a.example.com/v1",
        api: "openai-completions",
        models: [],
      },
    });
    await service.saveCustomProvider({
      provider: {
        id: "",
        name: "b",
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

  it("writes pi-compatible model entries with defaults", async () => {
    await service.saveCustomProvider({
      provider: {
        id: "",
        name: "gw",
        baseUrl: "https://x.example.com/v1",
        api: "openai-completions",
        authHeader: true,
        models: [{ id: "m1", reasoning: true, vision: true }],
      },
    });

    const raw = JSON.parse(readFileSync(join(testAgentDir, "models.json"), "utf8"));
    const provider = raw.providers.gw;
    expect(provider.authHeader).toBe(true);
    expect(provider.models[0]).toEqual({
      id: "m1",
      name: "m1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 128000,
      maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });

    // Reading back surfaces the pi fields as dialog state.
    const list = await service.listCustomProviders();
    expect(list[0].authHeader).toBe(true);
    expect(list[0].models[0]).toMatchObject({ id: "m1", name: "m1", reasoning: true, vision: true });
  });

  it("fills imported models from pi's official catalog on save", async () => {
    await service.saveCustomProvider({
      provider: {
        id: "",
        name: "Official relay",
        baseUrl: "https://relay.example.com/v1",
        api: "openai-completions",
        models: [{ id: "gpt-5.6-sol" }],
      },
    });

    const raw = JSON.parse(readFileSync(join(testAgentDir, "models.json"), "utf8"));
    const model = raw.providers["official-relay"].models[0];
    expect(model).toMatchObject({
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 272000,
      maxTokens: 128000,
    });
    expect(model.cost.tiers[0].inputTokensAbove).toBe(272000);
    expect(model.compat.supportsStrictMode).toBe(true);
    expect(model.thinkingLevelMap).toMatchObject({ low: "low", high: "high", max: "max" });
  });

  it("preserves explicit model overrides over official metadata", async () => {
    await service.saveCustomProvider({
      provider: {
        id: "",
        name: "Override relay",
        baseUrl: "https://relay.example.com/v1",
        api: "openai-completions",
        models: [{ id: "gpt-5.6-sol", reasoning: false, vision: false, contextWindow: 1_050_000 }],
      },
    });

    const raw = JSON.parse(readFileSync(join(testAgentDir, "models.json"), "utf8"));
    expect(raw.providers["override-relay"].models[0]).toMatchObject({
      reasoning: false,
      input: ["text"],
      contextWindow: 1_050_000,
      maxTokens: 128000,
    });
  });

  it("persists selected thinking levels as a thinkingLevelMap", async () => {
    await service.saveCustomProvider({
      provider: {
        id: "",
        name: "gw",
        baseUrl: "https://x.example.com/v1",
        api: "openai-completions",
        models: [
          { id: "m1", reasoning: true, thinkingLevels: ["low", "high"] },
          { id: "m2", reasoning: true }, // reasoning but no levels picked → no map
          { id: "m3", thinkingLevels: ["low"] }, // not reasoning → no map
        ],
      },
    });

    const raw = JSON.parse(readFileSync(join(testAgentDir, "models.json"), "utf8"));
    const models = raw.providers.gw.models;
    expect(models[0].thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    });
    expect(models[1].thinkingLevelMap).toBeUndefined();
    expect(models[2].thinkingLevelMap).toBeUndefined();

    // Reading back recovers the selected levels from the persisted map.
    const list = await service.listCustomProviders();
    expect(list[0].models[0].thinkingLevels?.sort()).toEqual(["high", "low"]);
  });

  it("preserves an existing thinkingLevelMap on re-save", async () => {
    const { writeFile } = await import("node:fs/promises");
    const custom = { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null };
    await writeFile(
      join(testAgentDir, "models.json"),
      JSON.stringify({
        providers: {
          gw: {
            baseUrl: "https://x.example.com/v1",
            api: "openai-completions",
            models: [{ id: "m1", reasoning: true, thinkingLevelMap: custom }],
          },
        },
      }),
    );

    await service.saveCustomProvider({
      provider: {
        id: "gw",
        baseUrl: "https://x.example.com/v1",
        api: "openai-completions",
        models: [{ id: "m1", reasoning: true }],
      },
    });

    const raw = JSON.parse(readFileSync(join(testAgentDir, "models.json"), "utf8"));
    expect(raw.providers.gw.models[0].thinkingLevelMap).toEqual(custom);
  });

  it("preserves unmanaged pi fields (headers, compat, cost) on save", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(testAgentDir, "models.json"),
      JSON.stringify({
        providers: {
          gw: {
            baseUrl: "https://old.example.com/v1",
            api: "openai-completions",
            headers: { "X-Corp": "yes" },
            models: [
              {
                id: "m1",
                name: "M1",
                reasoning: false,
                input: ["text"],
                contextWindow: 64000,
                maxTokens: 4096,
                cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
                compat: { supportsDeveloperRole: false },
              },
            ],
          },
        },
      }),
    );

    await service.saveCustomProvider({
      provider: {
        id: "gw",
        baseUrl: "https://new.example.com/v1",
        api: "openai-completions",
        models: [{ id: "m1", contextWindow: 200000 }],
      },
    });

    const raw = JSON.parse(readFileSync(join(testAgentDir, "models.json"), "utf8"));
    const provider = raw.providers.gw;
    expect(provider.baseUrl).toBe("https://new.example.com/v1");
    expect(provider.headers).toEqual({ "X-Corp": "yes" });
    expect(provider.models[0].contextWindow).toBe(200000);
    expect(provider.models[0].cost).toEqual({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 });
    expect(provider.models[0].compat).toEqual({ supportsDeveloperRole: false });
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

  it("rejects missing base URLs and unknown removals", async () => {
    await expect(
      service.saveCustomProvider({
        provider: { id: "", baseUrl: "  ", api: "openai-completions", models: [] },
      }),
    ).rejects.toThrow(/Base URL/);

    await expect(service.removeCustomProvider({ providerId: "missing" })).rejects.toThrow(/Unknown/);
  });

  describe("fetchModels", () => {
    afterAll(() => vi.unstubAllGlobals());

    it("enriches endpoint ids from pi's official catalog", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }] }), { status: 200 })),
      );

      await expect(
        service.fetchModels({ baseUrl: "https://relay.example.com/v1", apiKey: "secret" }),
      ).resolves.toEqual([
        expect.objectContaining({
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          reasoning: true,
          vision: true,
          contextWindow: 272000,
          maxTokens: 128000,
          thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
        }),
      ]);
    });
  });

  describe("catalogMeta (models.dev)", () => {
    const catalog = {
      openai: {
        api: "https://api.openai.com/v1",
        models: {
          "gpt-5": {
            name: "GPT-5",
            reasoning: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 400000, output: 128000 },
          },
        },
      },
      "other-host": {
        api: "https://other.example.com/v1",
        models: {
          "dup-model": { name: "Dup A" },
          "text-only": { name: "Text Only", modalities: { input: ["text"] }, limit: { context: 32000 } },
        },
      },
      "third-host": {
        models: { "dup-model": { name: "Dup B" } },
      },
    };

    beforeEach(() => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(catalog), { status: 200 })),
      );
    });

    afterAll(() => vi.unstubAllGlobals());

    it("matches models by base URL host and maps capabilities", async () => {
      const fresh = new ModelService();
      const meta = await fresh.catalogMeta({
        baseUrl: "https://api.openai.com/v1",
        modelIds: ["gpt-5", "unknown-model"],
      });
      expect(meta["gpt-5"]).toEqual({
        name: "GPT-5",
        reasoning: true,
        vision: true,
        contextWindow: 400000,
        maxTokens: 128000,
      });
      expect(meta["unknown-model"]).toBeUndefined();
    });

    it("falls back to a unique cross-provider id match, rejects ambiguous ids", async () => {
      const fresh = new ModelService();
      const meta = await fresh.catalogMeta({
        baseUrl: "https://self-hosted.internal/v1",
        modelIds: ["text-only", "dup-model"],
      });
      expect(meta["text-only"]).toMatchObject({ name: "Text Only", contextWindow: 32000 });
      expect(meta["text-only"].vision).toBeUndefined();
      expect(meta["dup-model"]).toBeUndefined();
    });

    it("resolves empty on catalog fetch failure", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("offline");
        }),
      );
      const fresh = new ModelService();
      await expect(fresh.catalogMeta({ baseUrl: "https://x.example.com/v1", modelIds: ["gpt-5"] })).resolves.toEqual(
        {},
      );
    });
  });

  it("derives the provider id from the name and dedupes collisions", async () => {
    const first = await service.saveCustomProvider({
      provider: {
        id: "",
        name: "My Gateway",
        baseUrl: "https://a.example.com/v1",
        api: "openai-completions",
        models: [],
      },
    });
    expect(first[0].id).toBe("my-gateway");

    // Same name again, empty id → a fresh entry with a numeric suffix.
    const second = await service.saveCustomProvider({
      provider: {
        id: "",
        name: "My Gateway",
        baseUrl: "https://b.example.com/v1",
        api: "openai-completions",
        models: [],
      },
    });
    expect(second.map((item) => item.id).sort()).toEqual(["my-gateway", "my-gateway-2"]);

    // CJK-only name: fall back to the base URL host.
    const third = await service.saveCustomProvider({
      provider: {
        id: "",
        name: "我的网关",
        baseUrl: "https://relay.example.com/v1",
        api: "openai-completions",
        models: [],
      },
    });
    expect(third.map((item) => item.id)).toContain("relay");
  });

  it("edits in place when the draft carries an existing provider id", async () => {
    await service.saveCustomProvider({
      provider: { id: "", name: "GW", baseUrl: "https://one.example.com/v1", api: "openai-completions", models: [] },
    });
    const list = await service.saveCustomProvider({
      provider: {
        id: "gw", // edit flow: draft was created from the existing entry
        name: "Renamed",
        baseUrl: "https://two.example.com/v1",
        api: "openai-completions",
        models: [],
      },
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "gw", name: "Renamed", baseUrl: "https://two.example.com/v1" });
  });
});
