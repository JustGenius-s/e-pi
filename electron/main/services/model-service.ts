import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

import type {
  CustomProviderConfig,
  CustomProviderRemoveRequest,
  CustomProviderRequest,
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

function modelsJsonPath(): string {
  return join(getAgentDir(), "models.json");
}

async function readModelsFile(): Promise<ModelsFile> {
  const path = modelsJsonPath();
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
  const path = modelsJsonPath();
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
    models: (config.models ?? []).map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: model.reasoning,
    })),
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
    const { id, name, baseUrl, api, apiKey, models } = request.provider;
    if (!CUSTOM_PROVIDER_ID_PATTERN.test(id)) {
      throw new Error("Provider ID must be lowercase letters, numbers, and hyphens only.");
    }
    if (!baseUrl.trim()) throw new Error("Base URL is required.");
    if (!api.trim()) throw new Error("API type is required.");
    const normalized = {
      ...(name?.trim() ? { name: name.trim() } : {}),
      baseUrl: baseUrl.trim(),
      api: api.trim(),
      ...(apiKey?.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(models.length > 0
        ? {
            models: models.map((model) => ({
              id: model.id.trim(),
              ...(model.name?.trim() ? { name: model.name.trim() } : {}),
              ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
              ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
              ...(model.reasoning ? { reasoning: true } : {}),
            })),
          }
        : {}),
    };
    if (normalized.models?.some((model) => !model.id)) {
      throw new Error("Every model needs an ID.");
    }

    const file = await readModelsFile();
    file.providers[id] = normalized;
    await writeModelsFile(file);
    return this.listCustomProviders();
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

    const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: true });
    const defaultProvider = settings.getDefaultProvider();
    const defaultModel = settings.getDefaultModel();

    return {
      providers,
      defaultModel: defaultProvider && defaultModel ? { provider: defaultProvider, id: defaultModel } : undefined,
      error: runtime.getError(),
    };
  }
}
