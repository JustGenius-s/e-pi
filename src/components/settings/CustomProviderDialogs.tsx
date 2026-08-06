import { LoaderCircle, Plus, RefreshCw, X } from "lucide-react";
import { useState } from "react";

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

/** 262144 → "256K", 1000000 → "1M". */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
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
      const existingIds = new Set(draft.models.map((model) => model.id));
      // Everything not already configured is pre-selected; rows that are
      // already in the list are shown disabled so they cannot be duplicated.
      setFetchedModels(fetched);
      setSelectedIds(new Set(fetched.filter((model) => !existingIds.has(model.id)).map((model) => model.id)));
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
              name: model.name || meta.name,
              reasoning: meta.reasoning,
              vision: meta.vision,
              contextWindow: meta.contextWindow,
              maxTokens: meta.maxTokens,
            }
          : model;
      });
    if (toAdd.length > 0) updateDraft({ models: [...draft.models, ...toAdd] });
    setFetchedModels(undefined);
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
                    <span>
                      API type <em className="custom-required">*</em>
                    </span>
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
                    <span>
                      Base URL <em className="custom-required">*</em>
                    </span>
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
                        if (!open) setFetchedModels(undefined);
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
                        </div>
                        <div className="model-fetch-list" onWheel={onListWheel}>
                          {(fetchedModels ?? []).map((model) => {
                            const alreadyAdded = draft?.models.some((current) => current.id === model.id);
                            const meta = catalogMeta[model.id];
                            return (
                              <label className="model-fetch-row" data-disabled={alreadyAdded || undefined} key={model.id}>
                                <Checkbox
                                  checked={alreadyAdded || selectedIds.has(model.id)}
                                  disabled={alreadyAdded}
                                  onCheckedChange={() => toggleSelected(model.id)}
                                />
                                <span className="model-fetch-id" title={model.id}>
                                  {model.id}
                                </span>
                                {meta ? (
                                  <span className="model-fetch-badges">
                                    {meta.vision ? <small title="Accepts image input">vision</small> : null}
                                    {meta.reasoning ? <small title="Supports extended thinking">reasoning</small> : null}
                                    {meta.contextWindow ? (
                                      <small title="Context window">{formatTokens(meta.contextWindow)}</small>
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
                          <Button size="sm" variant="outline" onClick={() => setFetchedModels(undefined)}>
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
                          onClick={() => updateDraft({ models: draft.models.filter((_, current) => current !== index) })}
                          disabled={busy}
                        >
                          <X size={13} />
                        </IconButton>
                      </div>
                      <div className="custom-model-meta">
                        <label className="custom-model-num">
                          <span>Context</span>
                          <Input
                            type="number"
                            value={model.contextWindow ?? ""}
                            placeholder="128000"
                            aria-label={`Model ${index + 1} context window`}
                            onChange={(event) =>
                              updateModel(index, {
                                contextWindow: event.target.value ? Number(event.target.value) : undefined,
                              })
                            }
                          />
                        </label>
                        <label className="custom-model-num">
                          <span>Max out</span>
                          <Input
                            type="number"
                            value={model.maxTokens ?? ""}
                            placeholder="8192"
                            aria-label={`Model ${index + 1} max tokens`}
                            onChange={(event) =>
                              updateModel(index, {
                                maxTokens: event.target.value ? Number(event.target.value) : undefined,
                              })
                            }
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
                        <div className="custom-model-levels" role="group" aria-label={`Model ${index + 1} thinking levels`}>
                          <span>Thinking levels</span>
                          <div className="custom-model-levels-options">
                            {THINKING_LEVELS.map((level) => (
                              <label className="custom-check" key={level}>
                                <Checkbox
                                  checked={model.thinkingLevels?.includes(level) ?? false}
                                  onCheckedChange={(checked) => updateModel(index, { thinkingLevels: toggleLevel(model.thinkingLevels, level, Boolean(checked)) })}
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
