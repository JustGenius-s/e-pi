import { useEffect, useMemo, useState } from "react";
import {
  Check,
  CircleCheck,
  KeyRound,
  LoaderCircle,
  LogIn,
  LogOut,
  Search,
} from "lucide-react";
import type {
  ModelAuthType,
  ModelLoginEvent,
  ModelManagementState,
  ModelProviderRecord,
} from "../types/contracts";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

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

export function ModelSettings({ active }: ModelSettingsProps) {
  const [state, setState] = useState<ModelManagementState>();
  const [selectedProviderId, setSelectedProviderId] = useState<string>();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [busyModel, setBusyModel] = useState<string>();
  const [busyLogout, setBusyLogout] = useState(false);
  const [error, setError] = useState<string>();
  const [login, setLogin] = useState<LoginFlow>();

  useEffect(() => {
    if (!active) {
      window.ePi.models.cancelLogin();
      setLogin(undefined);
      return;
    }

    let mounted = true;
    setLoading(true);
    setError(undefined);
    window.ePi.models.list()
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

    const stopLoginEvents = window.ePi.models.onLoginEvent((event) => {
      if (!mounted) return;
      setLogin((current) => {
        if (!current) return current;
        if (event.type === "prompt") {
          return { ...current, prompt: event, value: "", message: event.message, error: undefined };
        }
        if (event.type === "auth_url") {
          return { ...current, prompt: undefined, message: event.instructions || "Continue in your browser." };
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
      `${provider.name} ${provider.id}`.toLowerCase().includes(normalized));
  }, [query, state]);

  const provider = state?.providers.find((item) => item.id === selectedProviderId);
  const defaultModelRef = state?.defaultModel
    ? `${state.defaultModel.provider}/${state.defaultModel.id}`
    : undefined;

  const startLogin = (target: ModelProviderRecord, authType: ModelAuthType) => {
    setError(undefined);
    setLogin({
      providerId: target.id,
      authType,
      message: `Starting ${loginLabel(authType).toLowerCase()}...`,
      value: "",
    });
    void window.ePi.models.login({ providerId: target.id, type: authType })
      .then((next) => {
        setState(next);
        setLogin(undefined);
      })
      .catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : String(reason);
        if (message !== "Login cancelled") {
          setLogin((current) => current ? { ...current, error: message } : current);
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
    setLogin((current) => current
      ? { ...current, prompt: undefined, message: "Saving credential...", value: "" }
      : current);
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

  return (
    <div className="model-settings">
      <aside className="model-provider-pane">
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

        <div className="model-provider-list">
          {loading ? (
            <div className="model-settings-loading"><LoaderCircle className="spin" size={15} /> Loading providers</div>
          ) : filteredProviders.length === 0 ? (
            <div className="model-settings-empty">No providers found</div>
          ) : filteredProviders.map((item) => (
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
          ))}
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
                  <Button size="sm" variant="outline" onClick={() => startLogin(provider, "oauth")} disabled={Boolean(login)}>
                    <LogIn /> Account
                  </Button>
                ) : null}
                {provider.supportsApiKey ? (
                  <Button size="sm" variant="outline" onClick={() => startLogin(provider, "api_key")} disabled={Boolean(login)}>
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

            {login?.providerId === provider.id ? (
              <div className="model-login-flow">
                <div className="model-login-heading">
                  <strong>{loginLabel(login.authType)}</strong>
                  <Button size="xs" variant="ghost" onClick={cancelLogin}>Cancel</Button>
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
                      onChange={(event) => setLogin((current) => current
                        ? { ...current, value: event.target.value }
                        : current)}
                    />
                    <Button type="submit" disabled={!login.value.trim()}>Continue</Button>
                  </form>
                ) : login.error ? null : <LoaderCircle className="spin" size={16} />}
              </div>
            ) : null}

            {error || state?.error ? (
              <div className="model-settings-error" role="alert">{error || state?.error}</div>
            ) : null}

            <div className="model-list-heading">
              <span>Models</span>
              <small>{provider.models.filter((model) => model.available).length} available</small>
            </div>
            <div className="model-list">
              {provider.models.length === 0 ? (
                <div className="model-settings-empty">No models available</div>
              ) : provider.models.map((model) => {
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
                      {formatTokens(model.contextWindow)} context{model.reasoning ? " · reasoning" : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        ) : loading ? null : (
          <div className="model-settings-empty">Select a provider</div>
        )}
      </section>
    </div>
  );
}
