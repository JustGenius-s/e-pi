import {
  Check,
  CircleCheck,
  KeyRound,
  LoaderCircle,
  LogIn,
  LogOut,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type {
  CustomModelDefinition,
  CustomProviderConfig,
  ModelAuthType,
  ModelLoginEvent,
  ModelManagementState,
  ModelProviderRecord,
} from "../types/contracts";
import { IconButton } from "./IconButton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

interface ModelSettingsProps {
  active: boolean;
}

interface LoginFlow {
  providerId: string;
  authType: ModelAuthType;
  message: string;
  prompt?: Extract<ModelLoginEvent, { type: "prompt" }>;
  value: string;
  deviceCode?: string;
  error?: string;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

function loginLabel(type: ModelAuthType): string {
  return type === "oauth" ? "Account sign-in" : "API key";
}

const API_TYPES = ["openai-completions", "anthropic-messages", "openai-responses", "google-generative-ai"] as const;

interface CustomProviderDraft {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  models: CustomModelDefinition[];
}

export function ModelSettings({ active }: ModelSettingsProps) {
  const [state, setState] = useState<ModelManagementState>();
  const [selectedProviderId, setSelectedProviderId] = useState<string>();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [busyModel, setBusyModel] = useState<string>();
  const [busyLogout, setBusyLogout] = useState(false);
  const [error, setError] = useState<string>();
  const [login, setLogin] = useState<LoginFlow>();
  const [customProviders, setCustomProviders] = useState<CustomProviderConfig[]>([]);
  const [customDraft, setCustomDraft] = useState<CustomProviderDraft>();
  const [customRemove, setCustomRemove] = useState<string>();
  const [busyCustom, setBusyCustom] = useState(false);

  const loadState = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [next, custom] = await Promise.all([window.ePi.models.list(), window.ePi.models.customList()]);
      setState(next);
      setCustomProviders(custom);
      setSelectedProviderId((current) => {
        if (current && next.providers.some((provider) => provider.id === current)) return current;
        return next.providers.find((provider) => provider.configured)?.id ?? next.providers[0]?.id;
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!active) {
      window.ePi.models.cancelLogin();
      setLogin(undefined);
      return;
    }

    let mounted = true;
    setLoading(true);
    setError(undefined);
    window.ePi.models
      .list()
      .then((next) => {
        if (!mounted) return;
        setState(next);
        setSelectedProviderId((current) => {
          if (current && next.providers.some((provider) => provider.id === current)) return current;
          return next.providers.find((provider) => provider.configured)?.id ?? next.providers[0]?.id;
        });
      })
      .catch((reason: unknown) => {
        if (mounted) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    window.ePi.models
      .customList()
      .then((custom) => {
        if (mounted) setCustomProviders(custom);
      })
      .catch(() => {
        // Custom provider list is non-critical.
      });

    const stopLoginEvents = window.ePi.models.onLoginEvent((event) => {
      if (!mounted) return;
      setLogin((current) => {
        if (!current) return current;
        if (event.type === "prompt") {
          return { ...current, prompt: event, value: "", message: event.message, error: undefined };
        }
        if (event.type === "auth_url") {
          return {
            ...current,
            prompt: undefined,
            message: event.instructions || "Continue in your browser.",
          };
        }
        if (event.type === "device_code") {
          return {
            ...current,
            prompt: undefined,
            message: "Continue in your browser with this code.",
            deviceCode: event.userCode,
          };
        }
        if (event.type === "info" || event.type === "progress") {
          return { ...current, prompt: undefined, message: event.message };
        }
        if (event.type === "complete") {
          return { ...current, prompt: undefined, message: "Applying configuration..." };
        }
        if (event.type === "error") {
          return { ...current, prompt: undefined, error: event.message };
        }
        return undefined;
      });
    });

    return () => {
      mounted = false;
      stopLoginEvents();
    };
  }, [active]);

  const filteredProviders = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return state?.providers ?? [];
    return (state?.providers ?? []).filter((provider) =>
      `${provider.name} ${provider.id}`.toLowerCase().includes(normalized),
    );
  }, [query, state]);

  const provider = state?.providers.find((item) => item.id === selectedProviderId);
  const custom = customProviders.find((item) => item.id === provider?.id);
  const defaultModelRef = state?.defaultModel ? `${state.defaultModel.provider}/${state.defaultModel.id}` : undefined;

  const startLogin = (target: ModelProviderRecord, authType: ModelAuthType) => {
    setError(undefined);
    setLogin({
      providerId: target.id,
      authType,
      message: `Starting ${loginLabel(authType).toLowerCase()}...`,
      value: "",
    });
    void window.ePi.models
      .login({ providerId: target.id, type: authType })
      .then((next) => {
        setState(next);
        setLogin(undefined);
      })
      .catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : String(reason);
        if (message !== "Login cancelled") {
          setLogin((current) => (current ? { ...current, error: message } : current));
        }
      });
  };

  const cancelLogin = () => {
    window.ePi.models.cancelLogin();
    setLogin(undefined);
  };

  const answerPrompt = (value: string) => {
    if (!login?.prompt || !value.trim()) return;
    window.ePi.models.respondToLogin({ promptId: login.prompt.promptId, value: value.trim() });
    setLogin((current) =>
      current ? { ...current, prompt: undefined, message: "Saving credential...", value: "" } : current,
    );
  };

  const logout = async (target: ModelProviderRecord) => {
    setBusyLogout(true);
    setError(undefined);
    try {
      setState(await window.ePi.models.logout(target.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyLogout(false);
    }
  };

  const setDefaultModel = async (targetProvider: string, modelId: string) => {
    const ref = `${targetProvider}/${modelId}`;
    setBusyModel(ref);
    setError(undefined);
    try {
      setState(await window.ePi.models.setDefault({ provider: targetProvider, id: modelId }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyModel(undefined);
    }
  };

  const openCustomEditor = (existing?: CustomProviderConfig) => {
    setError(undefined);
    setCustomDraft(
      existing
        ? {
            id: existing.id,
            name: existing.name ?? "",
            baseUrl: existing.baseUrl ?? "",
            api: existing.api || "openai-completions",
            apiKey: existing.apiKey ?? "",
            models: existing.models?.length ? existing.models : [{ id: "" }],
          }
        : {
            id: "",
            name: "",
            baseUrl: "",
            api: "openai-completions",
            apiKey: "",
            models: [{ id: "" }],
          },
    );
  };

  const updateDraft = (patch: Partial<CustomProviderDraft>) => {
    setCustomDraft((current) => (current ? { ...current, ...patch } : current));
  };

  const updateDraftModel = (index: number, patch: Partial<CustomModelDefinition>) => {
    setCustomDraft((current) =>
      current
        ? {
            ...current,
            models: current.models.map((model, i) => (i === index ? { ...model, ...patch } : model)),
          }
        : current,
    );
  };

  const addDraftModel = () => {
    setCustomDraft((current) => (current ? { ...current, models: [...current.models, { id: "" }] } : current));
  };

  const removeDraftModel = (index: number) => {
    setCustomDraft((current) =>
      current ? { ...current, models: current.models.filter((_, i) => i !== index) } : current,
    );
  };

  const saveCustom = async () => {
    if (!customDraft) return;
    setBusyCustom(true);
    setError(undefined);
    try {
      await window.ePi.models.customSave({ provider: customDraft });
      setCustomDraft(undefined);
      await loadState();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyCustom(false);
    }
  };

  const removeCustom = async () => {
    if (!customRemove) return;
    setBusyCustom(true);
    setError(undefined);
    try {
      await window.ePi.models.customRemove({ providerId: customRemove });
      setCustomRemove(undefined);
      await loadState();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyCustom(false);
    }
  };

  return (
    <div className="model-settings">
      <aside className="model-provider-pane">
        <div className="model-provider-toolbar">
          <label className="model-provider-search">
            <Search size={14} />
            <span className="sr-only">Search providers</span>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search providers"
              type="search"
            />
          </label>
          <Button
            size="sm"
            variant="outline"
            onClick={() => openCustomEditor()}
            disabled={Boolean(login)}
            title="Add a custom provider (base URL + key) to ~/.pi/models.json"
          >
            <Plus size={14} />
            Custom
          </Button>
        </div>

        <div className="model-provider-list">
          {loading ? (
            <div className="model-settings-loading">
              <LoaderCircle className="spin" size={15} /> Loading providers
            </div>
          ) : filteredProviders.length === 0 ? (
            <div className="model-settings-empty">No providers found</div>
          ) : (
            filteredProviders.map((item) => (
              <button
                className="model-provider-row"
                data-active={item.id === selectedProviderId}
                key={item.id}
                onClick={() => setSelectedProviderId(item.id)}
                type="button"
              >
                <span>{item.name}</span>
                {item.configured ? <CircleCheck size={14} aria-label="Configured" /> : null}
                <small>{item.models.length} models</small>
              </button>
            ))
          )}
        </div>
      </aside>

      <section className="model-detail-pane">
        {provider ? (
          <>
            <div className="model-provider-heading">
              <div>
                <h3>{provider.name}</h3>
                <span>{provider.id}</span>
              </div>
              <div className="model-provider-actions">
                {provider.supportsOAuth ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => startLogin(provider, "oauth")}
                    disabled={Boolean(login)}
                  >
                    <LogIn /> Account
                  </Button>
                ) : null}
                {provider.supportsApiKey ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => startLogin(provider, "api_key")}
                    disabled={Boolean(login)}
                  >
                    <KeyRound /> API key
                  </Button>
                ) : null}
                {provider.storedAuthType ? (
                  <Button
                    aria-label={`Disconnect ${provider.name}`}
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => void logout(provider)}
                    disabled={busyLogout || Boolean(login)}
                    title="Disconnect"
                  >
                    {busyLogout ? <LoaderCircle className="spin" /> : <LogOut />}
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="model-auth-status" data-configured={provider.configured}>
              <span className="model-auth-dot" />
              {provider.configured ? provider.authSource || "Configured" : "Not configured"}
            </div>

            {custom ? (
              <div className="model-custom-row">
                <span className="model-custom-badge">Custom · models.json</span>
                <div className="model-custom-actions">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openCustomEditor(custom)}
                    disabled={Boolean(login) || busyCustom}
                  >
                    <Pencil size={13} />
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-destructive"
                    onClick={() => setCustomRemove(custom.id)}
                    disabled={busyCustom}
                  >
                    <Trash2 size={13} />
                    Remove
                  </Button>
                </div>
              </div>
            ) : null}

            {login?.providerId === provider.id ? (
              <div className="model-login-flow">
                <div className="model-login-heading">
                  <strong>{loginLabel(login.authType)}</strong>
                  <Button size="xs" variant="ghost" onClick={cancelLogin}>
                    Cancel
                  </Button>
                </div>
                <p>{login.error || login.message}</p>
                {login.deviceCode ? <code>{login.deviceCode}</code> : null}
                {login.prompt?.promptType === "select" ? (
                  <div className="model-login-options">
                    {login.prompt.options?.map((option) => (
                      <Button key={option.id} variant="outline" onClick={() => answerPrompt(option.id)}>
                        {option.label}
                      </Button>
                    ))}
                  </div>
                ) : login.prompt ? (
                  <form
                    className="model-login-input"
                    onSubmit={(event) => {
                      event.preventDefault();
                      answerPrompt(login.value);
                    }}
                  >
                    <Input
                      autoFocus
                      type={login.prompt.promptType === "secret" ? "password" : "text"}
                      value={login.value}
                      placeholder={login.prompt.placeholder}
                      onChange={(event) =>
                        setLogin((current) => (current ? { ...current, value: event.target.value } : current))
                      }
                    />
                    <Button type="submit" disabled={!login.value.trim()}>
                      Continue
                    </Button>
                  </form>
                ) : login.error ? null : (
                  <LoaderCircle className="spin" size={16} />
                )}
              </div>
            ) : null}

            {error || state?.error ? (
              <div className="model-settings-error" role="alert">
                {error || state?.error}
              </div>
            ) : null}

            <div className="model-list-heading">
              <span>Models</span>
              <small>{provider.models.filter((model) => model.available).length} available</small>
            </div>
            <div className="model-list">
              {provider.models.length === 0 ? (
                <div className="model-settings-empty">No models available</div>
              ) : (
                provider.models.map((model) => {
                  const ref = `${model.provider}/${model.id}`;
                  const selected = ref === defaultModelRef;
                  return (
                    <button
                      className="model-row"
                      data-selected={selected}
                      disabled={!model.available || Boolean(busyModel)}
                      key={ref}
                      onClick={() => void setDefaultModel(model.provider, model.id)}
                      type="button"
                    >
                      <span className="model-row-check">
                        {busyModel === ref ? <LoaderCircle className="spin" /> : selected ? <Check /> : null}
                      </span>
                      <span className="model-row-name">{model.name}</span>
                      <span className="model-row-meta">
                        {formatTokens(model.contextWindow)} context
                        {model.reasoning ? " · reasoning" : ""}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </>
        ) : loading ? null : (
          <div className="model-settings-empty">Select a provider</div>
        )}
      </section>

      <Dialog open={Boolean(customDraft)} onOpenChange={(next) => !next && setCustomDraft(undefined)}>
        <DialogContent className="custom-provider-dialog">
          <DialogHeader>
            <DialogTitle>
              {customDraft && customProviders.some((item) => item.id === customDraft.id)
                ? "Edit custom provider"
                : "Add custom provider"}
            </DialogTitle>
            <DialogDescription>
              Saved to ~/.pi/models.json. The provider appears in the list after saving.
            </DialogDescription>
          </DialogHeader>
          {customDraft ? (
            <div className="custom-provider-form">
              <label className="custom-field">
                <span>Provider ID</span>
                <Input
                  value={customDraft.id}
                  disabled={customProviders.some((item) => item.id === customDraft.id)}
                  placeholder="my-gateway"
                  onChange={(event) => updateDraft({ id: event.target.value })}
                />
              </label>
              <label className="custom-field">
                <span>Name</span>
                <Input
                  value={customDraft.name}
                  placeholder="My Gateway (optional)"
                  onChange={(event) => updateDraft({ name: event.target.value })}
                />
              </label>
              <div className="custom-field-row">
                <label className="custom-field">
                  <span>API type</span>
                  <Select value={customDraft.api} onValueChange={(value) => updateDraft({ api: value })}>
                    <SelectTrigger aria-label="API type">
                      <SelectValue placeholder="API type" />
                    </SelectTrigger>
                    <SelectContent>
                      {API_TYPES.map((api) => (
                        <SelectItem key={api} value={api}>
                          {api}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <label className="custom-field">
                  <span>Base URL</span>
                  <Input
                    value={customDraft.baseUrl}
                    placeholder="https://api.example.com/v1"
                    onChange={(event) => updateDraft({ baseUrl: event.target.value })}
                  />
                </label>
              </div>
              <label className="custom-field">
                <span>
                  API key <small>optional — literal or $ENV_VAR, stored in ~/.pi/models.json</small>
                </span>
                <Input
                  type="password"
                  value={customDraft.apiKey}
                  placeholder="$MY_API_KEY or sk-…"
                  onChange={(event) => updateDraft({ apiKey: event.target.value })}
                />
              </label>
              <div className="custom-models">
                <div className="custom-models-heading">
                  <span>Models</span>
                  <Button size="sm" variant="outline" onClick={addDraftModel} disabled={busyCustom}>
                    <Plus size={13} />
                    Add
                  </Button>
                </div>
                {customDraft.models.length === 0 ? (
                  <div className="custom-models-empty">No models — the provider will only expose overrides.</div>
                ) : (
                  customDraft.models.map((model, index) => (
                    <div className="custom-model-row" key={model.id || index}>
                      <Input
                        value={model.id}
                        placeholder="model-id"
                        aria-label={`Model ${index + 1} ID`}
                        onChange={(event) => updateDraftModel(index, { id: event.target.value })}
                      />
                      <Input
                        value={model.name ?? ""}
                        placeholder="Name"
                        aria-label={`Model ${index + 1} name`}
                        onChange={(event) => updateDraftModel(index, { name: event.target.value })}
                      />
                      <Input
                        type="number"
                        value={model.contextWindow ?? ""}
                        placeholder="Context"
                        aria-label={`Model ${index + 1} context window`}
                        onChange={(event) =>
                          updateDraftModel(index, {
                            contextWindow: event.target.value ? Number(event.target.value) : undefined,
                          })
                        }
                      />
                      <Input
                        type="number"
                        value={model.maxTokens ?? ""}
                        placeholder="Max tokens"
                        aria-label={`Model ${index + 1} max tokens`}
                        onChange={(event) =>
                          updateDraftModel(index, {
                            maxTokens: event.target.value ? Number(event.target.value) : undefined,
                          })
                        }
                      />
                      <label className="custom-model-reasoning">
                        <Checkbox
                          checked={Boolean(model.reasoning)}
                          onCheckedChange={(checked) => updateDraftModel(index, { reasoning: Boolean(checked) })}
                        />
                        <span>reasoning</span>
                      </label>
                      <IconButton
                        label={`Remove model ${index + 1}`}
                        onClick={() => removeDraftModel(index)}
                        disabled={customDraft.models.length === 1 || busyCustom}
                      >
                        <X size={13} />
                      </IconButton>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCustomDraft(undefined)}>
              Cancel
            </Button>
            <Button
              onClick={() => void saveCustom()}
              disabled={!customDraft?.id.trim() || !customDraft?.baseUrl.trim() || !customDraft?.api || busyCustom}
            >
              {busyCustom ? <LoaderCircle className="spin" /> : null}
              Save provider
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(customRemove)} onOpenChange={(next) => !next && setCustomRemove(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove custom provider?</AlertDialogTitle>
            <AlertDialogDescription>{customRemove} will be removed from ~/.pi/models.json.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void removeCustom()}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
