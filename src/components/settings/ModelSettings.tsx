import { Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { emitModelsCatalogChanged } from "../../lib/modelsCatalogBus";
import { isModelHidden, markProviderDefaultHidden, revealModelsForProvider } from "../../lib/modelVisibility";
import type {
  CustomProviderConfig,
  ModelAuthType,
  ModelManagementState,
  ModelProviderRecord,
} from "../../types/contracts";
import { CustomProviderDialogs, type CustomProviderDraft } from "./CustomProviderDialogs";
import { ModelProviderDetail, type ModelLoginFlow } from "./ModelProviderDetail";
import { ModelProviderList } from "./ModelProviderList";

interface ModelSettingsProps {
  active: boolean;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function draftFromProvider(existing?: CustomProviderConfig): CustomProviderDraft {
  return existing
    ? {
        id: existing.id,
        name: existing.name ?? "",
        baseUrl: existing.baseUrl ?? "",
        api: existing.api || "openai-completions",
        apiKey: existing.apiKey ?? "",
        authHeader: Boolean(existing.authHeader),
        models: existing.models?.length ? existing.models : [{ id: "" }],
      }
    : { id: "", name: "", baseUrl: "", api: "openai-completions", apiKey: "", authHeader: false, models: [{ id: "" }] };
}

/** The slug written to models.json may differ from the draft id (new providers). */
function resolveSavedProviderId(
  draft: CustomProviderDraft,
  saved: CustomProviderConfig[],
  previousIds: Set<string>,
): string | undefined {
  const requested = draft.id.trim();
  if (requested && saved.some((provider) => provider.id === requested)) return requested;
  const baseUrl = draft.baseUrl.trim();
  const name = draft.name.trim();
  const matches = saved.filter((provider) => provider.baseUrl === baseUrl && (provider.name ?? "") === name);
  return matches.find((provider) => !previousIds.has(provider.id))?.id ?? matches[0]?.id;
}

export function ModelSettings({ active }: ModelSettingsProps) {
  const [state, setState] = useState<ModelManagementState>();
  const [selectedProviderId, setSelectedProviderId] = useState<string>();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [busyModel, setBusyModel] = useState<string>();
  const [busyLogout, setBusyLogout] = useState(false);
  const [error, setError] = useState<string>();
  const [login, setLogin] = useState<ModelLoginFlow>();
  const [customProviders, setCustomProviders] = useState<CustomProviderConfig[]>([]);
  const [customDraft, setCustomDraft] = useState<CustomProviderDraft>();
  const [customRemove, setCustomRemove] = useState<string>();
  const [busyCustom, setBusyCustom] = useState(false);

  const selectProvider = (providers: ModelProviderRecord[], current?: string) => {
    if (current && providers.some((provider) => provider.id === current)) return current;
    return providers.find((provider) => provider.configured)?.id ?? providers[0]?.id;
  };

  const loadState = async (options?: { silent?: boolean; selectProviderId?: string }) => {
    if (!options?.silent) setLoading(true);
    setError(undefined);
    try {
      const next = await window.ePi.models.list();
      setState(next);
      setSelectedProviderId((current) => selectProvider(next.providers, options?.selectProviderId ?? current));
      try {
        setCustomProviders(await window.ePi.models.customList());
      } catch {
        // Custom provider metadata is optional; keep the provider list usable.
      }
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      if (!options?.silent) setLoading(false);
    }
  };

  useEffect(() => {
    if (!active) {
      window.ePi.models.cancelLogin();
      setLogin(undefined);
      return;
    }
    let mounted = true;
    void loadState();
    const stopLoginEvents = window.ePi.models.onLoginEvent((event) => {
      if (!mounted) return;
      setLogin((current) => {
        if (!current) return current;
        if (event.type === "prompt")
          return { ...current, prompt: event, value: "", message: event.message, error: undefined };
        if (event.type === "auth_url")
          return { ...current, prompt: undefined, message: event.instructions || "Continue in your browser." };
        if (event.type === "device_code")
          return {
            ...current,
            prompt: undefined,
            message: "Continue in your browser with this code.",
            deviceCode: event.userCode,
          };
        if (event.type === "info" || event.type === "progress")
          return { ...current, prompt: undefined, message: event.message };
        if (event.type === "complete") return { ...current, prompt: undefined, message: "Applying configuration..." };
        if (event.type === "error") return { ...current, prompt: undefined, error: event.message };
        return undefined;
      });
    });
    return () => {
      mounted = false;
      stopLoginEvents();
    };
  }, [active]);

  const provider = state?.providers.find((item) => item.id === selectedProviderId);
  const custom = customProviders.find((item) => item.id === provider?.id);
  const defaultModelRef = state?.defaultModel ? `${state.defaultModel.provider}/${state.defaultModel.id}` : undefined;

  const startLogin = (target: ModelProviderRecord, authType: ModelAuthType) => {
    setError(undefined);
    setLogin({
      providerId: target.id,
      authType,
      message: `Starting ${authType === "oauth" ? "account sign-in" : "API key"}...`,
      value: "",
    });
    void window.ePi.models
      .login({ providerId: target.id, type: authType })
      .then((next) => {
        setState(next);
        setLogin(undefined);
        // A freshly configured provider shows no models until the user
        // turns them on (default-hidden); idempotent, never overrides an
        // explicit choice.
        markProviderDefaultHidden(target.id);
        emitModelsCatalogChanged();
      })
      .catch((reason: unknown) => {
        const message = errorMessage(reason);
        if (message !== "Login cancelled") setLogin((current) => (current ? { ...current, error: message } : current));
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
      setError(errorMessage(reason));
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
      setError(errorMessage(reason));
    } finally {
      setBusyModel(undefined);
    }
  };

  const saveCustom = async () => {
    if (!customDraft) return;
    // Drop model rows that have no id (user clicked Add but never typed
    // one, or rows left empty around a Fetch merge) so saving never fails
    // with "Every model needs an ID.".
    const cleanDraft = {
      ...customDraft,
      models: customDraft.models.filter((model) => model.id.trim().length > 0),
    };
    const previousIds = new Set(
      customProviders.find((item) => item.id === cleanDraft.id)?.models.map((model) => model.id) ?? [],
    );
    const previousProviderIds = new Set(customProviders.map((item) => item.id));
    setBusyCustom(true);
    setError(undefined);
    try {
      const saved = await window.ePi.models.customSave({ provider: cleanDraft });
      const savedId = resolveSavedProviderId(cleanDraft, saved, previousProviderIds);
      setCustomDraft(undefined);
      if (savedId) {
        // Newly added models (and any that were already visible) stay on;
        // everything else of this provider stays off. Avoids the previous
        // "save → mark default-hidden → every switch flips off" behavior.
        const shownRefs = cleanDraft.models
          .filter((model) => {
            const id = model.id.trim();
            return !previousIds.has(id) || !isModelHidden(`${savedId}/${id}`);
          })
          .map((model) => `${savedId}/${model.id.trim()}`);
        revealModelsForProvider(savedId, shownRefs);
      }
      await loadState({ silent: true, selectProviderId: savedId });
      emitModelsCatalogChanged();
    } catch (reason) {
      setError(errorMessage(reason));
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
      await loadState({ silent: true });
      emitModelsCatalogChanged();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyCustom(false);
    }
  };

  const filteredProviders = useMemo(() => state?.providers ?? [], [state]);
  return (
    <div className="model-settings">
      <div className="model-settings-header">
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
          onClick={() => setCustomDraft(draftFromProvider())}
          disabled={Boolean(login)}
          title="Add a custom provider (base URL + key) to ~/.pi/models.json"
        >
          <Plus size={14} />
          Custom
        </Button>
      </div>
      <div className="model-settings-body">
        <ModelProviderList
          providers={filteredProviders}
          selectedProviderId={selectedProviderId}
          query={query}
          loading={loading}
          onSelect={setSelectedProviderId}
        />
        <section className="model-detail-pane">
          <ModelProviderDetail
            provider={provider}
            custom={custom}
            defaultModelRef={defaultModelRef}
            login={login}
            loading={loading}
            busyModel={busyModel}
            busyLogout={busyLogout}
            busyCustom={busyCustom}
            error={error || state?.error}
            onStartLogin={startLogin}
            onCancelLogin={cancelLogin}
            onLoginValueChange={(value) => setLogin((current) => (current ? { ...current, value } : current))}
            onAnswerPrompt={answerPrompt}
            onLogout={(target) => void logout(target)}
            onSetDefaultModel={(providerId, modelId) => void setDefaultModel(providerId, modelId)}
            onEditCustom={(target) => setCustomDraft(draftFromProvider(target))}
            onRemoveCustom={setCustomRemove}
          />
        </section>
      </div>
      <CustomProviderDialogs
        providers={customProviders}
        draft={customDraft}
        removeId={customRemove}
        busy={busyCustom}
        onDraftChange={setCustomDraft}
        onRemoveIdChange={setCustomRemove}
        onSave={() => void saveCustom()}
        onRemove={() => void removeCustom()}
      />
    </div>
  );
}
