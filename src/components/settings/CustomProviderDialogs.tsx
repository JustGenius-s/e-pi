import { LoaderCircle, Plus, X } from "lucide-react";

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
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => updateDraft({ models: [...draft.models, { id: "" }] })}
                    disabled={busy}
                  >
                    <Plus size={13} /> Add
                  </Button>
                </div>
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
