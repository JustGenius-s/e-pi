import { randomUUID } from "node:crypto";
import {
  getAgentDir,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
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

export class ModelService {
  #loginController: AbortController | undefined;
  #pendingPrompt: PendingPrompt | undefined;

  async list(cwd: string): Promise<ModelManagementState> {
    const runtime = await this.#createRuntime();
    return this.#snapshot(runtime, cwd);
  }

  async login(
    request: ModelLoginRequest,
    cwd: string,
    onEvent: LoginEventListener,
  ): Promise<ModelManagementState> {
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
        prompt: (prompt) => new Promise<string>((resolve, reject) => {
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

  async #createRuntime(): Promise<ModelRuntime> {
    return ModelRuntime.create({ allowModelNetwork: false });
  }

  async #snapshot(runtime: ModelRuntime, cwd: string): Promise<ModelManagementState> {
    const credentials = new Map(
      (await runtime.listCredentials()).map((credential) => [credential.providerId, credential.type]),
    );
    const availableModels = new Set(
      runtime.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`),
    );
    const providers = runtime.getProviders().map((provider) => {
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
        models: runtime.getModels(provider.id)
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
    }).sort((left, right) => {
      if (left.configured !== right.configured) return left.configured ? -1 : 1;
      return left.name.localeCompare(right.name);
    });

    const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: true });
    const defaultProvider = settings.getDefaultProvider();
    const defaultModel = settings.getDefaultModel();

    return {
      providers,
      defaultModel: defaultProvider && defaultModel
        ? { provider: defaultProvider, id: defaultModel }
        : undefined,
      error: runtime.getError(),
    };
  }
}
