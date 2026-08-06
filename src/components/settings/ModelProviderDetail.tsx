import { Check, KeyRound, LoaderCircle, LogIn, LogOut, Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import type { CustomProviderConfig, ModelAuthType, ModelLoginEvent, ModelProviderRecord } from "../../types/contracts";

export interface ModelLoginFlow {
  providerId: string;
  authType: ModelAuthType;
  message: string;
  prompt?: Extract<ModelLoginEvent, { type: "prompt" }>;
  value: string;
  deviceCode?: string;
  error?: string;
}

interface ModelProviderDetailProps {
  provider?: ModelProviderRecord;
  custom?: CustomProviderConfig;
  defaultModelRef?: string;
  login?: ModelLoginFlow;
  loading: boolean;
  busyModel?: string;
  busyLogout: boolean;
  busyCustom: boolean;
  error?: string;
  onStartLogin: (provider: ModelProviderRecord, type: ModelAuthType) => void;
  onCancelLogin: () => void;
  onLoginValueChange: (value: string) => void;
  onAnswerPrompt: (value: string) => void;
  onLogout: (provider: ModelProviderRecord) => void;
  onSetDefaultModel: (provider: string, modelId: string) => void;
  onEditCustom: (provider: CustomProviderConfig) => void;
  onRemoveCustom: (providerId: string) => void;
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

function loginLabel(type: ModelAuthType): string {
  return type === "oauth" ? "Account sign-in" : "API key";
}

export function ModelProviderDetail({
  provider,
  custom,
  defaultModelRef,
  login,
  loading,
  busyModel,
  busyLogout,
  busyCustom,
  error,
  onStartLogin,
  onCancelLogin,
  onLoginValueChange,
  onAnswerPrompt,
  onLogout,
  onSetDefaultModel,
  onEditCustom,
  onRemoveCustom,
}: ModelProviderDetailProps) {
  if (!provider) return loading ? null : <div className="model-settings-empty">Select a provider</div>;
  return (
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
              onClick={() => onStartLogin(provider, "oauth")}
              disabled={Boolean(login)}
            >
              <LogIn /> Account
            </Button>
          ) : null}
          {provider.supportsApiKey ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onStartLogin(provider, "api_key")}
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
              onClick={() => onLogout(provider)}
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
              onClick={() => onEditCustom(custom)}
              disabled={Boolean(login) || busyCustom}
            >
              <Pencil size={13} /> Edit
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-destructive"
              onClick={() => onRemoveCustom(custom.id)}
              disabled={busyCustom}
            >
              <Trash2 size={13} /> Remove
            </Button>
          </div>
        </div>
      ) : null}
      {login?.providerId === provider.id ? (
        <div className="model-login-flow">
          <div className="model-login-heading">
            <strong>{loginLabel(login.authType)}</strong>
            <Button size="xs" variant="ghost" onClick={onCancelLogin}>
              Cancel
            </Button>
          </div>
          <p>{login.error || login.message}</p>
          {login.deviceCode ? <code>{login.deviceCode}</code> : null}
          {login.prompt?.promptType === "select" ? (
            <div className="model-login-options">
              {login.prompt.options?.map((option) => (
                <Button key={option.id} variant="outline" onClick={() => onAnswerPrompt(option.id)}>
                  {option.label}
                </Button>
              ))}
            </div>
          ) : login.prompt ? (
            <form
              className="model-login-input"
              onSubmit={(event) => {
                event.preventDefault();
                onAnswerPrompt(login.value);
              }}
            >
              <Input
                autoFocus
                type={login.prompt.promptType === "secret" ? "password" : "text"}
                value={login.value}
                placeholder={login.prompt.placeholder}
                onChange={(event) => onLoginValueChange(event.target.value)}
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
      {error ? (
        <div className="model-settings-error" role="alert">
          {error}
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
                onClick={() => onSetDefaultModel(model.provider, model.id)}
                type="button"
              >
                <span className="model-row-check">
                  {busyModel === ref ? <LoaderCircle className="spin" /> : selected ? <Check /> : null}
                </span>
                <span className="model-row-name">{model.name}</span>
                <span className="model-row-meta">
                  {formatContextWindow(model.contextWindow)} context{model.reasoning ? " · reasoning" : ""}
                </span>
              </button>
            );
          })
        )}
      </div>
    </>
  );
}
