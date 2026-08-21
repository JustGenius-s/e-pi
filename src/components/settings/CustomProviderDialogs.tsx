import { ChevronDown, LoaderCircle, Plus, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import {
  compactTokenLabel,
  CONTEXT_WINDOW_PRESETS,
  MAX_OUTPUT_PRESETS,
  parseTokenInput,
  tokenPresetLabel,
} from "../../lib/tokenPreset";
import type { CustomModelDefinition, CustomProviderConfig, ModelCatalogMeta } from "../../types/contracts";

const API_TYPES = ["openai-completions", "anthropic-messages", "openai-responses", "google-generative-ai"] as const;

/** Thinking levels offered in the model card (pi levels minus "off"). */
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Toggle one level in a multi-select list; empty result becomes undefined. */
function toggleLevel(levels: string[] | undefined, level: string, on: boolean): string[] | undefined {
  const next = new Set(levels ?? []);
  if (on) next.add(level);
  else next.delete(level);
  return next.size > 0 ? [...next] : undefined;
}

function TokenPresetField({
  value,
  presets,
  placeholder,
  ariaLabel,
  onChange,
}: {
  value?: number;
  presets: number[];
  placeholder: string;
  ariaLabel: string;
  onChange: (next?: number) => void;
}) {
  const [draft, setDraft] = useState(() => (value != null ? String(value) : ""));
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setDraft(value != null ? String(value) : "");
  }, [value]);

  const commit = (raw: string) => {
    if (!raw.trim()) {
      onChange(undefined);
      setDraft("");
      return;
    }
    const parsed = parseTokenInput(raw);
    if (parsed == null) {
      setDraft(value != null ? String(value) : "");
      return;
    }
    onChange(parsed);
    setDraft(String(parsed));
  };

  return (
    <div className="custom-model-token-field">
      <Input
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        inputMode="decimal"
        aria-label={ariaLabel}
        title="Number of tokens, or shorthand like 128k / 1M"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit(draft);
          }
        }}
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="custom-model-token-chevron"
            aria-label={`${ariaLabel} presets`}
            title="Choose a preset"
          >
            <ChevronDown size={12} />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="custom-model-token-presets">
          {presets.map((tokens) => (
            <button
              key={tokens}
              type="button"
              className="custom-model-token-preset"
              data-selected={value === tokens ? "true" : "false"}
              onClick={() => {
                onChange(tokens);
                setDraft(String(tokens));
                setOpen(false);
              }}
            >
              {tokenPresetLabel(tokens)}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}

export interface CustomProviderDraft {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  authHeader: boolean;
  models: CustomModelDefinition[];
}

interface CustomProviderDialogsProps {
  providers: CustomProviderConfig[];
  draft?: CustomProviderDraft;
  removeId?: string;
  busy: boolean;
  onDraftChange: (draft?: CustomProviderDraft) => void;
  onRemoveIdChange: (providerId?: string) => void;
  onSave: () => void;
  onRemove: () => void;
}

export function CustomProviderDialogs({
  providers,
  draft,
  removeId,
  busy,
  onDraftChange,
  onRemoveIdChange,
  onSave,
  onRemove,
}: CustomProviderDialogsProps) {
  const updateDraft = (patch: Partial<CustomProviderDraft>) => onDraftChange(draft ? { ...draft, ...patch } : draft);
  const updateModel = (index: number, patch: Partial<CustomModelDefinition>) => {
    if (!draft) return;
    updateDraft({ models: draft.models.map((model, current) => (current === index ? { ...model, ...patch } : model)) });
  };
  const existing = Boolean(draft && providers.some((provider) => provider.id === draft.id));
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string>();
  // Models fetched from the endpoint, held until the user confirms which of
  // them to add (popover with a scrollable, selectable list).
  const [fetchedModels, setFetchedModels] = useState<CustomModelDefinition[] | undefined>();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Curated metadata from models.dev, keyed by model id. Best-effort: ids
  // without a catalog match just stay at defaults.
  const [catalogMeta, setCatalogMeta] = useState<Record<string, ModelCatalogMeta>>({});
  const fetchModels = async () => {
    if (!draft || fetching) return;
    setFetching(true);
    setFetchError(undefined);
    try {
      const fetched = await window.ePi.models.fetchModels({ baseUrl: draft.baseUrl, apiKey: draft.apiKey });
      // Start with nothing selected — the user picks what to add. Rows that
      // are already in the list are shown disabled so they cannot be duplicated.
      setFetchedModels(fetched);
      setSelectedIds(new Set());
      // Enrich in the background; the popover is already usable meanwhile.
      void window.ePi.models
        .catalogMeta({ baseUrl: draft.baseUrl, modelIds: fetched.map((model) => model.id) })
        .then((meta) => setCatalogMeta((current) => ({ ...current, ...meta })))
        .catch(() => undefined);
    } catch (reason) {
      setFetchError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setFetching(false);
    }
  };
  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };
  // The dialog's scroll lock (react-remove-scroll) intercepts wheel events in
  // capture phase and prevents them when the hovered location cannot scroll
  // natively (e.g. the list has not overflowed yet), which would make the
  // list feel dead. It only preventDefaults, so scroll manually here to keep
  // the list responsive in all cases.
  const onListWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const list = event.currentTarget;
    if (event.deltaY !== 0) {
      list.scrollTop += event.deltaY;
      event.preventDefault();
    }
  };
  const addSelected = () => {
    if (!draft) return;
    const existingIds = new Set(draft.models.map((model) => model.id));
    const toAdd = (fetchedModels ?? [])
      .filter((model) => selectedIds.has(model.id) && !existingIds.has(model.id))
      .map((model) => {
        const meta = catalogMeta[model.id];
        // Pre-fill curated capabilities; the user can still edit every field
        // before saving, and unmatched ids fall back to the bare id.
        return meta
          ? {
              ...model,
              name: model.name || meta.name || model.id,
              reasoning: model.reasoning ?? meta.reasoning,
              vision: model.vision ?? meta.vision,
              contextWindow: model.contextWindow ?? meta.contextWindow,
              maxTokens: model.maxTokens ?? meta.maxTokens,
              thinkingLevels: model.thinkingLevels,
            }
          : model;
      });
    if (toAdd.length > 0) updateDraft({ models: [...draft.models, ...toAdd] });
    setFetchedModels(undefined);
    setSelectedIds(new Set());
  };
  return (
    <>
      <Dialog open={Boolean(draft)} onOpenChange={(open) => !open && onDraftChange(undefined)}>
        <DialogContent className="custom-provider-dialog">
          <DialogHeader>
            <DialogTitle>{existing ? "Edit custom provider" : "Add custom provider"}</DialogTitle>
            <DialogDescription>Saved to ~/.pi/models.json.</DialogDescription>
          </DialogHeader>
          {draft ? (
            <div className="custom-provider-form">
              <section className="custom-section">
                {/* The provider ID is derived from the name (or host) on save;
                    users never see or manage it. */}
                <label className="custom-field">
                  <span>Name</span>
                  <Input
                    value={draft.name}
                    placeholder="My Gateway (optional)"
                    onChange={(event) => updateDraft({ name: event.target.value })}
                  />
                </label>
                <div className="custom-field-row">
                  <label className="custom-field">
                    <span>API type</span>
                    <Select value={draft.api} onValueChange={(api) => updateDraft({ api })}>
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
                      value={draft.baseUrl}
                      placeholder="https://api.example.com/v1"
                      onChange={(event) => updateDraft({ baseUrl: event.target.value })}
                    />
                  </label>
                </div>
              </section>
              <section className="custom-section">
                <label className="custom-field">
                  <span>API key</span>
                  <Input
                    type="password"
                    value={draft.apiKey}
                    placeholder="$MY_API_KEY or sk-… (optional)"
                    onChange={(event) => updateDraft({ apiKey: event.target.value })}
                  />
                </label>
                <label className="custom-check" title="Adds Authorization: Bearer <apiKey> to every request">
                  <Checkbox
                    checked={draft.authHeader}
                    onCheckedChange={(checked) => updateDraft({ authHeader: Boolean(checked) })}
                  />
                  <span>Send Authorization: Bearer header</span>
                </label>
              </section>
              <section className="custom-section custom-models">
                <div className="custom-models-heading">
                  <span>
                    Models <small>{draft.models.length}</small>
                  </span>
                  <div className="custom-models-actions">
                    <Popover
                      open={fetchedModels !== undefined}
                      onOpenChange={(open) => {
                        if (!open) {
                          setFetchedModels(undefined);
                          setSelectedIds(new Set());
                        }
                      }}
                    >
                      <PopoverTrigger asChild>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void fetchModels()}
                          disabled={busy || fetching || !draft.baseUrl.trim()}
                          title="Fetch the model list from {baseUrl}/models"
                        >
                          {fetching ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />} Fetch
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="model-fetch-popover">
                        <div className="model-fetch-heading">
                          <span>Select models to add</span>
                          <small>{fetchedModels?.length ?? 0} found</small>
                          <button
                            type="button"
                            className="model-fetch-select-all"
                            onClick={() => {
                              const existingIds = new Set(draft?.models.map((model) => model.id));
                              setSelectedIds(
                                new Set(
                                  (fetchedModels ?? [])
                                    .filter((model) => !existingIds.has(model.id))
                                    .map((model) => model.id),
                                ),
                              );
                            }}
                          >
                            Select all
                          </button>
                        </div>
                        <div className="model-fetch-list" onWheel={onListWheel}>
                          {(fetchedModels ?? []).map((model) => {
                            const alreadyAdded = draft?.models.some((current) => current.id === model.id);
                            const meta = catalogMeta[model.id];
                            const vision = Boolean(model.vision ?? meta?.vision);
                            const reasoning = Boolean(model.reasoning ?? meta?.reasoning);
                            const contextWindow = model.contextWindow ?? meta?.contextWindow;
                            return (
                              <label
                                className="model-fetch-row"
                                data-disabled={alreadyAdded || undefined}
                                key={model.id}
                              >
                                <Checkbox
                                  checked={selectedIds.has(model.id)}
                                  disabled={alreadyAdded}
                                  onCheckedChange={() => {
                                    if (!alreadyAdded) toggleSelected(model.id);
                                  }}
                                />
                                <span className="model-fetch-id" title={model.id}>
                                  {model.id}
                                </span>
                                {vision || reasoning || contextWindow ? (
                                  <span className="model-fetch-badges">
                                    {vision ? <small title="Accepts image input">vision</small> : null}
                                    {reasoning ? <small title="Supports extended thinking">reasoning</small> : null}
                                    {contextWindow ? (
                                      <small title="Context window">{compactTokenLabel(contextWindow)}</small>
                                    ) : null}
                                  </span>
                                ) : null}
                                {alreadyAdded ? <small className="model-fetch-added">added</small> : null}
                              </label>
                            );
                          })}
                          {(fetchedModels ?? []).length === 0 ? (
                            <div className="model-fetch-empty">No models returned.</div>
                          ) : null}
                        </div>
                        <div className="model-fetch-footer">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setFetchedModels(undefined);
                              setSelectedIds(new Set());
                            }}
                          >
                            Cancel
                          </Button>
                          <Button size="sm" onClick={addSelected} disabled={selectedIds.size === 0}>
                            Add selected ({selectedIds.size})
                          </Button>
                        </div>
                      </PopoverContent>
                    </Popover>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => updateDraft({ models: [...draft.models, { id: "" }] })}
                      disabled={busy}
                    >
                      <Plus size={13} /> Add
                    </Button>
                  </div>
                </div>
                {fetchError ? <div className="model-settings-error">{fetchError}</div> : null}
                {draft.models.length === 0 ? (
                  <div className="custom-models-empty">No models yet.</div>
                ) : (
                  draft.models.map((model, index) => (
                    <div className="custom-model-card" key={model.id || index}>
                      <div className="custom-model-main">
                        <Input
                          className="custom-model-id"
                          value={model.id}
                          placeholder="model-id *"
                          aria-label={`Model ${index + 1} ID`}
                          onChange={(event) => updateModel(index, { id: event.target.value })}
                        />
                        <Input
                          value={model.name ?? ""}
                          placeholder="Display name (optional)"
                          aria-label={`Model ${index + 1} name`}
                          onChange={(event) => updateModel(index, { name: event.target.value })}
                        />
                        <IconButton
                          label={`Remove model ${index + 1}`}
                          onClick={() =>
                            updateDraft({ models: draft.models.filter((_, current) => current !== index) })
                          }
                          disabled={busy}
                        >
                          <X size={13} />
                        </IconButton>
                      </div>
                      <div className="custom-model-meta">
                        <label className="custom-model-num">
                          <span>Context</span>
                          <TokenPresetField
                            value={model.contextWindow}
                            presets={CONTEXT_WINDOW_PRESETS}
                            placeholder="128k or 128000"
                            ariaLabel={`Model ${index + 1} context window`}
                            onChange={(contextWindow) => updateModel(index, { contextWindow })}
                          />
                        </label>
                        <label className="custom-model-num">
                          <span>Max out</span>
                          <TokenPresetField
                            value={model.maxTokens}
                            presets={MAX_OUTPUT_PRESETS}
                            placeholder="8k or 8192"
                            ariaLabel={`Model ${index + 1} max tokens`}
                            onChange={(maxTokens) => updateModel(index, { maxTokens })}
                          />
                        </label>
                        <label className="custom-check" title="Supports extended thinking">
                          <Checkbox
                            checked={Boolean(model.reasoning)}
                            onCheckedChange={(checked) => updateModel(index, { reasoning: Boolean(checked) })}
                          />
                          <span>reasoning</span>
                        </label>
                        <label className="custom-check" title="Accepts image input">
                          <Checkbox
                            checked={Boolean(model.vision)}
                            onCheckedChange={(checked) => updateModel(index, { vision: Boolean(checked) })}
                          />
                          <span>vision</span>
                        </label>
                      </div>
                      {model.reasoning ? (
                        <div
                          className="custom-model-levels"
                          role="group"
                          aria-label={`Model ${index + 1} thinking levels`}
                        >
                          <span>Thinking levels</span>
                          <div className="custom-model-levels-options">
                            {THINKING_LEVELS.map((level) => (
                              <label className="custom-check" key={level}>
                                <Checkbox
                                  checked={model.thinkingLevels?.includes(level) ?? false}
                                  onCheckedChange={(checked) =>
                                    updateModel(index, {
                                      thinkingLevels: toggleLevel(model.thinkingLevels, level, Boolean(checked)),
                                    })
                                  }
                                />
                                <span>{level}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ))
                )}
              </section>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => onDraftChange(undefined)}>
              Cancel
            </Button>
            <Button onClick={onSave} disabled={!draft?.baseUrl.trim() || !draft?.api || busy}>
              {busy ? <LoaderCircle className="spin" /> : null} Save provider
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={Boolean(removeId)} onOpenChange={(open) => !open && onRemoveIdChange(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove custom provider?</AlertDialogTitle>
            <AlertDialogDescription>{removeId} will be removed from ~/.pi/models.json.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onRemove}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
