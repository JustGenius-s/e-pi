import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { loadPiAgent, piPackageDir } from "./pi-agent-loader";

import type {
  CatalogMetaRequest,
  CustomModelDefinition,
  CustomProviderConfig,
  CustomProviderRemoveRequest,
  CustomProviderRequest,
  FetchModelsRequest,
  ModelCatalogMeta,
  ModelAuthType,
  ModelLoginEvent,
  ModelLoginRequest,
  ModelLoginResponse,
  ModelManagementState,
  SetDefaultModelRequest,
} from "../../../src/types/contracts";

type LoginEventListener = (event: ModelLoginEvent) => void;

interface PendingPrompt {
  id: string;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

function authSourceLabel(source?: string, label?: string): string | undefined {
  if (label) return label;
  switch (source) {
    case "stored":
      return "Saved credential";
    case "environment":
      return "Environment";
    case "models_json_key":
    case "models_json_command":
      return "models.json";
    case "fallback":
      return "Provider fallback";
    case "runtime":
      return "Runtime key";
    default:
      return undefined;
  }
}

const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Derive a provider slug from the display name, falling back to the base
 * URL's host when the name yields nothing usable (e.g. CJK-only names).
 * Always matches CUSTOM_PROVIDER_ID_PATTERN.
 */
function slugifyProviderId(name: string, baseUrl: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (slug) return slug;
  try {
    const host = new URL(baseUrl.trim()).hostname.replace(/^www\./, "");
    const fromHost = host.split(".")[0]?.replace(/[^a-z0-9]+/g, "-") ?? "";
    if (fromHost && CUSTOM_PROVIDER_ID_PATTERN.test(fromHost)) return fromHost;
  } catch {
    // fall through to the generic id
  }
  return "custom";
}

/** Remove line and block comments from JSON text, preserving string contents. */
function stripJsonComments(source: string): string {
  let result = "";
  let i = 0;
  let inString = false;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (inString) {
      result += char;
      if (char === "\\") {
        result += next ?? "";
        i += 2;
        continue;
      }
      if (char === '"') inString = false;
      i += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      i += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    result += char;
    i += 1;
  }
  return result;
}

interface ModelsFile {
  providers: Record<string, Partial<CustomProviderConfig>>;
}

/** models.json model entries may declare input modalities directly. */
interface RawModelEntry {
  id?: unknown;
  name?: unknown;
  contextWindow?: unknown;
  maxTokens?: unknown;
  reasoning?: unknown;
  input?: unknown;
  thinkingLevelMap?: unknown;
  cost?: unknown;
  compat?: unknown;
}

interface OfficialModelMetadata {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Record<string, string | null>;
  cost?: Record<string, unknown>;
  compat?: Record<string, unknown>;
}

let officialModelsPromise: Promise<Map<string, OfficialModelMetadata>> | undefined;

async function officialModels(): Promise<Map<string, OfficialModelMetadata>> {
  if (!officialModelsPromise) {
    officialModelsPromise = (async () => {
      try {
        const packageDir = piPackageDir();
        const resolvedPackageDir = realpathSync(packageDir);
        const candidates = [
          join(dirname(resolvedPackageDir), "pi-ai/dist/providers/data"),
          join(resolvedPackageDir, "node_modules/@earendil-works/pi-ai/dist/providers/data"),
          join(dirname(packageDir), "pi-ai/dist/providers/data"),
          join(packageDir, "node_modules/@earendil-works/pi-ai/dist/providers/data"),
        ];
        const dataDir = candidates.find((candidate) => existsSync(candidate));
        if (!dataDir) throw new Error(`pi-ai model catalog not found near ${packageDir}`);
        const files = (await readdir(dataDir)).filter((file) => file.endsWith(".json"));
        const preferred = ["openai", "anthropic", "google", "deepseek", "moonshotai", "minimax", "mistral"];
        files.sort((left, right) => {
          const rank = (file: string) => {
            const index = preferred.indexOf(file.slice(0, -5));
            return index < 0 ? preferred.length : index;
          };
          return rank(left) - rank(right);
        });
        const result = new Map<string, OfficialModelMetadata>();
        const catalogs = await Promise.all(
          files.map(async (file) =>
            JSON.parse(await readFile(join(dataDir, file), "utf8")) as Record<
              string,
              Record<string, OfficialModelMetadata>
            >,
          ),
        );
        for (const groups of catalogs) {
          for (const models of Object.values(groups)) {
            for (const model of Object.values(models)) {
              if (!result.has(model.id)) result.set(model.id, model);
            }
          }
        }
        return result;
      } catch (error) {
        console.warn("Could not load pi official model catalog", error);
        return new Map<string, OfficialModelMetadata>();
      }
    })();
  }
  return officialModelsPromise;
}

function officialFor(id: string, catalog: Map<string, OfficialModelMetadata>): OfficialModelMetadata | undefined {
  return catalog.get(id) ?? catalog.get(id.replace(/-ioa$/, ""));
}

function toCustomModel(model: RawModelEntry): CustomModelDefinition {
  return {
    id: typeof model.id === "string" ? model.id : "",
    name: typeof model.name === "string" ? model.name : undefined,
    contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : undefined,
    maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : undefined,
    reasoning: typeof model.reasoning === "boolean" ? model.reasoning : undefined,
    thinkingLevels: thinkingLevelsFromMap(model.thinkingLevelMap),
    // Preserve an explicit text-only declaration so a later save does not
    // re-enable vision from catalog metadata.
    vision: Array.isArray(model.input) ? model.input.includes("image") : undefined,
  };
}

/** Inverse of buildThinkingLevelMap: levels with a non-null mapped value. */
function thinkingLevelsFromMap(map: unknown): string[] | undefined {
  if (!map || typeof map !== "object" || Array.isArray(map)) return undefined;
  const levels = THINKING_LEVELS.filter((level) => (map as Record<string, unknown>)[level] != null);
  return levels.length > 0 ? [...levels] : undefined;
}

async function modelsJsonPath(): Promise<string> {
  const { getAgentDir } = await loadPiAgent();
  return join(getAgentDir(), "models.json");
}

async function readModelsFile(): Promise<ModelsFile> {
  const path = await modelsJsonPath();
  if (!existsSync(path)) return { providers: {} };
  const raw = await readFile(path, "utf8");
  try {
    const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const providers = (parsed as Partial<ModelsFile>).providers;
      if (providers && typeof providers === "object" && !Array.isArray(providers)) {
        return { providers: providers as Record<string, Partial<CustomProviderConfig>> };
      }
    }
    return { providers: {} };
  } catch {
    throw new Error(`Could not parse ${path}. Fix the JSON file before adding custom providers.`);
  }
}

async function writeModelsFile(file: ModelsFile): Promise<void> {
  const path = await modelsJsonPath();
  await mkdir(dirname(path), { recursive: true });
  const payload = { providers: file.providers };
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function toCustomProvider(id: string, config: Partial<CustomProviderConfig>): CustomProviderConfig {
  return {
    id,
    name: config.name,
    baseUrl: config.baseUrl ?? "",
    api: config.api ?? "",
    apiKey: config.apiKey,
    authHeader: (config as { authHeader?: boolean }).authHeader === true ? true : undefined,
    models: ((config.models ?? []) as RawModelEntry[]).map((model) => toCustomModel(model)),
  };
}

export class ModelService {
  #loginController: AbortController | undefined;
  #pendingPrompt: PendingPrompt | undefined;

  async list(cwd: string): Promise<ModelManagementState> {
    const runtime = await this.#createRuntime();
    return this.#snapshot(runtime, cwd);
  }

  async login(request: ModelLoginRequest, cwd: string, onEvent: LoginEventListener): Promise<ModelManagementState> {
    if (this.#loginController) throw new Error("Another provider login is already in progress.");

    const runtime = await this.#createRuntime();
    const provider = runtime.getProvider(request.providerId);
    if (!provider) throw new Error(`Unknown provider: ${request.providerId}`);
    if (request.type === "api_key" && !provider.auth.apiKey?.login) {
      throw new Error(`${provider.name} does not support API key setup in E-Pi.`);
    }
    if (request.type === "oauth" && !provider.auth.oauth) {
      throw new Error(`${provider.name} does not support account sign-in.`);
    }

    const controller = new AbortController();
    this.#loginController = controller;

    try {
      await runtime.login(request.providerId, request.type, {
        signal: controller.signal,
        prompt: (prompt) =>
          new Promise<string>((resolve, reject) => {
            if (controller.signal.aborted || prompt.signal?.aborted) {
              reject(new Error("Login cancelled"));
              return;
            }

            const id = randomUUID();
            const abort = () => {
              if (this.#pendingPrompt?.id === id) this.#pendingPrompt = undefined;
              reject(new Error("Login cancelled"));
            };
            controller.signal.addEventListener("abort", abort, { once: true });
            prompt.signal?.addEventListener("abort", abort, { once: true });

            this.#pendingPrompt = {
              id,
              resolve,
              reject,
              cleanup: () => {
                controller.signal.removeEventListener("abort", abort);
                prompt.signal?.removeEventListener("abort", abort);
              },
            };

            onEvent({
              type: "prompt",
              promptId: id,
              promptType: prompt.type,
              message: prompt.message,
              placeholder: prompt.type === "select" ? undefined : prompt.placeholder,
              options: prompt.type === "select" ? [...prompt.options] : undefined,
            });
          }),
        notify: (event) => {
          if (event.type === "auth_url") {
            onEvent({ type: "auth_url", url: event.url, instructions: event.instructions });
          } else if (event.type === "device_code") {
            onEvent({
              type: "device_code",
              userCode: event.userCode,
              verificationUri: event.verificationUri,
              expiresInSeconds: event.expiresInSeconds,
            });
          } else if (event.type === "info") {
            onEvent({ type: "info", message: event.message });
          } else {
            onEvent({ type: "progress", message: event.message });
          }
        },
      });

      onEvent({ type: "complete", providerId: request.providerId });
      return this.#snapshot(runtime, cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted || message === "Login cancelled") {
        onEvent({ type: "cancelled" });
      } else {
        onEvent({ type: "error", message });
      }
      throw error;
    } finally {
      this.#pendingPrompt?.cleanup();
      this.#pendingPrompt = undefined;
      if (this.#loginController === controller) this.#loginController = undefined;
    }
  }

  respondToLogin({ promptId, value }: ModelLoginResponse): void {
    const prompt = this.#pendingPrompt;
    if (!prompt || prompt.id !== promptId) return;
    prompt.cleanup();
    this.#pendingPrompt = undefined;
    prompt.resolve(value);
  }

  cancelLogin(): void {
    this.#loginController?.abort();
  }

  async logout(providerId: string, cwd: string): Promise<ModelManagementState> {
    const runtime = await this.#createRuntime();
    await runtime.logout(providerId);
    return this.#snapshot(runtime, cwd);
  }

  async setDefault(request: SetDefaultModelRequest, cwd: string): Promise<ModelManagementState> {
    const runtime = await this.#createRuntime();
    if (!runtime.getModel(request.provider, request.id)) {
      throw new Error(`Unknown model: ${request.provider}/${request.id}`);
    }

    const { SettingsManager, getAgentDir } = await loadPiAgent();
    const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: true });
    settings.setDefaultModelAndProvider(request.provider, request.id);
    await settings.flush();
    return this.#snapshot(runtime, cwd);
  }

  async listCustomProviders(): Promise<CustomProviderConfig[]> {
    const { providers } = await readModelsFile();
    return Object.entries(providers)
      .filter(([, config]) => config && typeof config === "object")
      .map(([id, config]) => toCustomProvider(id, config))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async saveCustomProvider(request: CustomProviderRequest): Promise<CustomProviderConfig[]> {
    const { name, baseUrl, api, apiKey, authHeader, models } = request.provider;
    if (!baseUrl.trim()) throw new Error("Base URL is required.");
    if (!api.trim()) throw new Error("API type is required.");
    if (models.some((model) => !model.id.trim())) {
      throw new Error("Every model needs an ID.");
    }

    const file = await readModelsFile();
    const officialCatalog = await officialModels();
    // The dialog no longer exposes a Provider ID field: an explicit (valid) id
    // means "edit that entry"; anything else derives a fresh unique slug.
    const requested = request.provider.id.trim();
    const id =
      CUSTOM_PROVIDER_ID_PATTERN.test(requested) && requested in file.providers
        ? requested
        : await this.#uniqueProviderId(slugifyProviderId(name ?? "", baseUrl), file);
    // Start from the existing entry so fields pi supports but the dialog does
    // not edit (headers, compat, thinkingLevelMap, per-model cost, ...) survive
    // a save. Only the keys the dialog manages are overwritten below.
    const existing = file.providers[id] ?? {};
    const existingModels = Array.isArray(existing.models) ? (existing.models as unknown as Record<string, unknown>[]) : [];
    const normalized: Record<string, unknown> = {
      ...existing,
      baseUrl: baseUrl.trim(),
      api: api.trim(),
    };
    if (name?.trim()) normalized.name = name.trim();
    else delete normalized.name;
    if (apiKey?.trim()) normalized.apiKey = apiKey.trim();
    else delete normalized.apiKey;
    if (authHeader) normalized.authHeader = true;
    else delete normalized.authHeader;
    if (models.length > 0) {
      normalized.models = models.map((model) => {
        const modelId = model.id.trim();
        const extras = existingModels.find((entry) => entry && entry.id === modelId) ?? {};
        const official = officialFor(modelId, officialCatalog);
        const reasoning = model.reasoning ?? official?.reasoning ?? false;
        const vision = model.vision ?? official?.input?.includes("image") ?? false;
        const thinkingMap = reasoning ? buildThinkingLevelMap(model.thinkingLevels) : undefined;
        const entry: Record<string, unknown> = {
          // Extras first so the dialog-managed keys below always win.
          ...extras,
          id: modelId,
          name: model.name?.trim() || official?.name || modelId,
          reasoning,
          // Persist explicit input modalities so pi's vision gate
          // (model.input.includes("image")) never misclassifies the model.
          input: vision ? ["text", "image"] : ["text"],
          contextWindow: model.contextWindow || official?.contextWindow || 128_000,
          maxTokens: model.maxTokens || official?.maxTokens || 8_192,
          cost: extras.cost ?? official?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
        if (!extras.compat && official?.compat) entry.compat = official.compat;
        // An explicit level selection wins; otherwise retain hand-tuned data,
        // then fall back to pi's official model metadata.
        if (thinkingMap) entry.thinkingLevelMap = thinkingMap;
        else if (extras.thinkingLevelMap) entry.thinkingLevelMap = extras.thinkingLevelMap;
        else if (official?.thinkingLevelMap) entry.thinkingLevelMap = official.thinkingLevelMap;
        return entry;
      });
    } else {
      delete normalized.models;
    }

    file.providers[id] = normalized as Partial<CustomProviderConfig>;
    await writeModelsFile(file);
    return this.listCustomProviders();
  }

  /** Pick a slug not used by models.json or any built-in provider. */
  async #uniqueProviderId(base: string, file: ModelsFile): Promise<string> {
    let taken: Set<string>;
    try {
      const runtime = await this.#createRuntime();
      taken = new Set(runtime.getProviders().map((provider) => provider.id));
    } catch {
      taken = new Set();
    }
    for (const key of Object.keys(file.providers)) taken.add(key);
    if (!taken.has(base)) return base;
    for (let suffix = 2; ; suffix++) {
      const candidate = `${base}-${suffix}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  async removeCustomProvider(request: CustomProviderRemoveRequest): Promise<CustomProviderConfig[]> {
    const file = await readModelsFile();
    if (!(request.providerId in file.providers)) {
      throw new Error(`Unknown custom provider: ${request.providerId}`);
    }
    delete file.providers[request.providerId];
    await writeModelsFile(file);
    return this.listCustomProviders();
  }

  async #createRuntime(): Promise<ModelRuntime> {
    const { ModelRuntime } = await loadPiAgent();
    return ModelRuntime.create({ allowModelNetwork: false });
  }

  async #snapshot(runtime: ModelRuntime, cwd: string): Promise<ModelManagementState> {
    const credentials = new Map(
      (await runtime.listCredentials()).map((credential) => [credential.providerId, credential.type]),
    );
    const availableModels = new Set(runtime.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`));
    const providers = runtime
      .getProviders()
      .map((provider) => {
        const status = runtime.getProviderAuthStatus(provider.id);
        return {
          id: provider.id,
          name: provider.name,
          configured: status.configured,
          authSource: authSourceLabel(status.source, status.label),
          storedAuthType: credentials.get(provider.id) as ModelAuthType | undefined,
          supportsApiKey: Boolean(provider.auth.apiKey?.login),
          supportsOAuth: Boolean(provider.auth.oauth),
          apiKeyLabel: provider.auth.apiKey?.name,
          oauthLabel: provider.auth.oauth?.loginLabel ?? provider.auth.oauth?.name,
          models: runtime
            .getModels(provider.id)
            .map((model) => ({
              provider: model.provider,
              id: model.id,
              name: model.name,
              api: model.api,
              reasoning: model.reasoning,
              contextWindow: model.contextWindow,
              maxTokens: model.maxTokens,
              available: availableModels.has(`${model.provider}/${model.id}`),
            }))
            .sort((left, right) => left.name.localeCompare(right.name)),
        };
      })
      .sort((left, right) => {
        if (left.configured !== right.configured) return left.configured ? -1 : 1;
        return left.name.localeCompare(right.name);
      });

    const { SettingsManager, getAgentDir } = await loadPiAgent();
    const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: true });
    const defaultProvider = settings.getDefaultProvider();
    const defaultModel = settings.getDefaultModel();

    return {
      providers,
      defaultModel: defaultProvider && defaultModel ? { provider: defaultProvider, id: defaultModel } : undefined,
      error: runtime.getError(),
    };
  }

  /**
   * Fetch the model list from an OpenAI-compatible `/models` endpoint.
   * Tries `<baseUrl>/models` first; when the base URL does not already end
   * in `/v1`, falls back to `<baseUrl>/v1/models` (the OpenAI layout).
   */
  async fetchModels(request: FetchModelsRequest): Promise<CustomModelDefinition[]> {
    const base = request.baseUrl.trim().replace(/\/+$/, "");
    if (!base) throw new Error("Base URL is required");
    const candidates = [`${base}/models`];
    if (!/\/v1$/i.test(base)) candidates.push(`${base}/v1/models`);
    let lastError: unknown;
    for (const url of candidates) {
      try {
        const response = await fetch(url, {
          headers: {
            ...(request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {}),
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          lastError = new Error(`HTTP ${response.status} ${response.statusText} from ${url}`);
          continue;
        }
        const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
        if (!Array.isArray(payload.data)) {
          throw new Error(`Unexpected response shape from ${url}`);
        }
        const catalog = await officialModels();
        return payload.data
          .filter((item): item is { id: string } => typeof item.id === "string" && item.id.length > 0)
          .map((item) => {
            const official = officialFor(item.id, catalog);
            return {
              id: item.id,
              name: official?.name,
              reasoning: official?.reasoning,
              vision: official?.input?.includes("image") || undefined,
              contextWindow: official?.contextWindow,
              maxTokens: official?.maxTokens,
              thinkingLevels: thinkingLevelsFromMap(official?.thinkingLevelMap),
            };
          });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Failed to fetch models");
  }

  /**
   * Look up curated metadata for the given model ids from the models.dev
   * community catalog (https://models.dev/api.json). Best-effort: network or
   * shape failures resolve to an empty map, and unmatched ids are simply
   * absent from the result.
   *
   * Matching: providers whose api.json `api` URL shares a host with the
   * configured base URL are consulted first (exact provider match); a unique
   * model-id match anywhere else in the catalog is used as fallback. Only
   * exact matches contribute cost data — the same model id can be priced
   * differently by another serving provider.
   */
  /** Catalog cache: the JSON is ~MBs and changes slowly; reuse for 10 min. */
  #modelsDevCache: { at: number; catalog: ModelsDevCatalog } | undefined;

  async catalogMeta(request: CatalogMetaRequest): Promise<Record<string, ModelCatalogMeta>> {
    const wanted = [...new Set(request.modelIds.map((id) => id.trim()).filter(Boolean))];
    const result: Record<string, ModelCatalogMeta> = {};
    if (wanted.length === 0) return result;
    let host = "";
    try {
      host = new URL(request.baseUrl.trim()).hostname.replace(/^www\./, "");
    } catch {
      // Keep matching by model id only.
    }
    if (!this.#modelsDevCache || Date.now() - this.#modelsDevCache.at >= MODELS_DEV_CACHE_MS) {
      const catalog = await fetchModelsDevCatalog();
      if (catalog) this.#modelsDevCache = { at: Date.now(), catalog };
    }
    const catalog = this.#modelsDevCache?.catalog;
    if (!catalog) return result;
    for (const modelId of wanted) {
      const match = findCatalogModel(catalog, modelId, host);
      if (!match) continue;
      const meta: ModelCatalogMeta = {};
      if (typeof match.name === "string" && match.name) meta.name = match.name;
      if (match.reasoning === true) meta.reasoning = true;
      const input = match.modalities?.input;
      if (Array.isArray(input) && input.includes("image")) meta.vision = true;
      if (typeof match.limit?.context === "number") meta.contextWindow = match.limit.context;
      if (typeof match.limit?.output === "number") meta.maxTokens = match.limit.output;
      result[modelId] = meta;
    }
    return result;
  }
}

/** Selectable thinking levels ("off" is implicit: pick no level at all). */
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Build a thinkingLevelMap from the levels the user enabled: selected levels
 * map to their effort string, unselected ones to null (hidden in pi), plus
 * off: null. Returns undefined when the model is not a reasoning model or no
 * level was picked (pi then falls back to its provider defaults).
 */
function buildThinkingLevelMap(levels: string[] | undefined): Record<string, string | null> | undefined {
  if (!levels || levels.length === 0) return undefined;
  const map: Record<string, string | null> = { off: null };
  for (const level of THINKING_LEVELS) map[level] = levels.includes(level) ? level : null;
  return map;
}

/* --- models.dev catalog --- */

const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_CACHE_MS = 10 * 60 * 1000;

interface ModelsDevModel {
  name?: unknown;
  reasoning?: unknown;
  modalities?: { input?: unknown };
  limit?: { context?: unknown; output?: unknown };
}

interface ModelsDevProvider {
  api?: unknown;
  models?: Record<string, ModelsDevModel>;
}

type ModelsDevCatalog = Record<string, ModelsDevProvider>;

async function fetchModelsDevCatalog(): Promise<ModelsDevCatalog | undefined> {
  try {
    const response = await fetch(MODELS_DEV_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
    return body as ModelsDevCatalog;
  } catch {
    return undefined;
  }
}

/** Host-exact provider match first; fall back to a unique model-id match. */
function findCatalogModel(catalog: ModelsDevCatalog, modelId: string, host: string): ModelsDevModel | undefined {
  if (host) {
    for (const provider of Object.values(catalog)) {
      if (typeof provider?.api !== "string" || !provider.models) continue;
      try {
        if (new URL(provider.api).hostname.replace(/^www\./, "") !== host) continue;
      } catch {
        continue;
      }
      const model = provider.models[modelId];
      if (model) return model;
    }
  }
  // Fallback: only trust a model-id match that is unique across the catalog;
  // capabilities can genuinely differ per serving provider.
  let found: ModelsDevModel | undefined;
  for (const provider of Object.values(catalog)) {
    const model = provider?.models?.[modelId];
    if (!model) continue;
    if (found) return undefined;
    found = model;
  }
  return found;
}
