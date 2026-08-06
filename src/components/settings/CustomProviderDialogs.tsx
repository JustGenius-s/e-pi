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

import type { CustomModelDefinition, CustomProviderConfig } from "../../types/contracts";

const API_TYPES = ["openai-completions", "anthropic-messages", "openai-responses", "google-generative-ai"] as const;

export interface CustomProviderDraft {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
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
    const toAdd = (fetchedModels ?? []).filter((model) => selectedIds.has(model.id) && !existingIds.has(model.id));
    if (toAdd.length > 0) updateDraft({ models: [...draft.models, ...toAdd] });
    setFetchedModels(undefined);
  };
  return (
    <>
      <Dialog open={Boolean(draft)} onOpenChange={(open) => !open && onDraftChange(undefined)}>
        <DialogContent className="custom-provider-dialog">
          <DialogHeader>
            <DialogTitle>{existing ? "Edit custom provider" : "Add custom provider"}</DialogTitle>
            <DialogDescription>
              Saved to ~/.pi/models.json. The provider appears in the list after saving.
            </DialogDescription>
          </DialogHeader>
          {draft ? (
            <div className="custom-provider-form">
              <label className="custom-field">
                <span>Provider ID</span>
                <Input
                  value={draft.id}
                  disabled={existing}
                  placeholder="my-gateway"
                  onChange={(event) => updateDraft({ id: event.target.value })}
                />
              </label>
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
              <label className="custom-field">
                <span>
                  API key <small>optional — literal or $ENV_VAR, stored in ~/.pi/models.json</small>
                </span>
                <Input
                  type="password"
                  value={draft.apiKey}
                  placeholder="$MY_API_KEY or sk-…"
                  onChange={(event) => updateDraft({ apiKey: event.target.value })}
                />
              </label>
              <div className="custom-models">
                <div className="custom-models-heading">
                  <span>Models</span>
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
                  <div className="custom-models-empty">No models — the provider will only expose overrides.</div>
                ) : (
                  draft.models.map((model, index) => (
                    <div className="custom-model-row" key={model.id || index}>
                      <Input
                        value={model.id}
                        placeholder="model-id"
                        aria-label={`Model ${index + 1} ID`}
                        onChange={(event) => updateModel(index, { id: event.target.value })}
                      />
                      <Input
                        value={model.name ?? ""}
                        placeholder="Name"
                        aria-label={`Model ${index + 1} name`}
                        onChange={(event) => updateModel(index, { name: event.target.value })}
                      />
                      <Input
                        type="number"
                        value={model.contextWindow ?? ""}
                        placeholder="Context"
                        aria-label={`Model ${index + 1} context window`}
                        onChange={(event) =>
                          updateModel(index, {
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
                          updateModel(index, { maxTokens: event.target.value ? Number(event.target.value) : undefined })
                        }
                      />
                      <label className="custom-model-reasoning">
                        <Checkbox
                          checked={Boolean(model.reasoning)}
                          onCheckedChange={(checked) => updateModel(index, { reasoning: Boolean(checked) })}
                        />
                        <span>reasoning</span>
                      </label>
                      <label className="custom-model-reasoning">
                        <Checkbox
                          checked={Boolean(model.vision)}
                          onCheckedChange={(checked) => updateModel(index, { vision: Boolean(checked) })}
                        />
                        <span title="Image input support">vision</span>
                      </label>
                      <IconButton
                        label={`Remove model ${index + 1}`}
                        onClick={() => updateDraft({ models: draft.models.filter((_, current) => current !== index) })}
                        disabled={draft.models.length === 1 || busy}
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
            <Button variant="outline" onClick={() => onDraftChange(undefined)}>
              Cancel
            </Button>
            <Button onClick={onSave} disabled={!draft?.id.trim() || !draft?.baseUrl.trim() || !draft?.api || busy}>
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
