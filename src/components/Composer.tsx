import { ArrowRight, File, FolderOpen, Plus, Sparkles, Square, X } from "lucide-react";
import { useEffect, useState } from "react";

import type {
  ContextUsageState,
  ModelManagementState,
  ModelRecord,
  ModelRef,
  PiActivityStatus,
  PiProcessStatus,
  SessionUsageState,
  SkillRecord,
} from "../types/contracts";
import { SessionStats } from "./SessionStats";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  Menubar,
  MenubarContent,
  MenubarGroup,
  MenubarLabel,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from "./ui/menubar";
import { Textarea } from "./ui/textarea";

interface ComposerProps {
  sessionPath?: string;
  status: PiProcessStatus;
  activity?: PiActivityStatus;
  model?: ModelRef;
  context?: ContextUsageState;
  usage?: SessionUsageState;
  cacheHitRate?: number;
  speed?: number;
  disabled: boolean;
  cwd?: string;
  onSubmit: (messages: string[]) => Promise<boolean>;
  onInterrupt: () => void;
}

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const THINKING_LEVELS: Array<{ value: ThinkingLevel; label: string; note: string }> = [
  { value: "off", label: "Off", note: "Fastest response" },
  { value: "minimal", label: "Minimal", note: "Light reasoning" },
  { value: "low", label: "Low", note: "Short reasoning" },
  { value: "medium", label: "Medium", note: "Balanced" },
  { value: "high", label: "High", note: "Deeper reasoning" },
  { value: "xhigh", label: "X-high", note: "Maximum depth" },
  { value: "max", label: "Max", note: "As deep as possible" },
];

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const isImage = (path: string) => IMAGE_EXT.test(path);

function displayModel(model: ModelRecord): string {
  return model.name || model.id;
}

export function Composer({
  sessionPath,
  status,
  activity,
  model,
  context,
  usage,
  cacheHitRate,
  speed,
  disabled,
  cwd,
  onSubmit,
  onInterrupt,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [models, setModels] = useState<ModelManagementState>();
  const [pendingModel, setPendingModel] = useState<{ sessionPath?: string; ref: string }>();
  const [thinking, setThinking] = useState<ThinkingLevel>("medium");
  const [files, setFiles] = useState<string[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<string>();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<SkillRecord>();
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const busy = status === "starting" || status === "stopping" || submitting;
  const hasContent = Boolean(text.trim() || files.length > 0 || selectedSkill);
  const showStop = status === "running" && activity === "busy";
  const availableProviders =
    models?.providers
      .map((provider) => ({
        ...provider,
        models: provider.models.filter((candidate) => candidate.available),
      }))
      .filter((provider) => provider.models.length > 0) ?? [];
  const availableModels = availableProviders.flatMap((provider) => provider.models);
  const actualModelRef = model
    ? `${model.provider}/${model.id}`
    : !sessionPath && models?.defaultModel
      ? `${models.defaultModel.provider}/${models.defaultModel.id}`
      : "";
  const modelRef = pendingModel && pendingModel.sessionPath === sessionPath ? pendingModel.ref : actualModelRef;
  const selectedModel = availableModels.find((candidate) => `${candidate.provider}/${candidate.id}` === modelRef);
  const selectedModelLabel = selectedModel ? displayModel(selectedModel) : (model?.id ?? "Model");
  const selectedThinking = THINKING_LEVELS.find((level) => level.value === thinking);

  useEffect(() => {
    window.ePi.models
      .list()
      .then(setModels)
      .catch(() => undefined);
  }, [cwd]);

  useEffect(() => {
    setPendingModel(undefined);
  }, [sessionPath, model?.provider, model?.id]);

  useEffect(() => {
    if (!pendingModel) return;
    const timeout = window.setTimeout(() => {
      setPendingModel((current) => (current === pendingModel ? undefined : current));
    }, 5_000);
    return () => window.clearTimeout(timeout);
  }, [pendingModel]);

  useEffect(() => {
    setFiles([]);
    setSelectedSkill(undefined);
    if (!cwd) {
      setSkills([]);
      return;
    }
    window.ePi.skills
      .list(cwd)
      .then(setSkills)
      .catch(() => setSkills([]));
  }, [cwd]);

  useEffect(() => {
    for (const path of files.filter(isImage)) {
      if (thumbnails[path]) continue;
      void window.ePi.app
        .imageData(path, 64)
        .then((dataUrl) => {
          if (dataUrl) setThumbnails((current) => ({ ...current, [path]: dataUrl }));
        })
        .catch(() => undefined);
    }
  }, [files, thumbnails]);

  useEffect(() => {
    if (!preview) {
      setPreviewUrl(undefined);
      return;
    }
    void window.ePi.app
      .imageData(preview)
      .then((dataUrl) => setPreviewUrl(dataUrl ?? undefined))
      .catch(() => setPreviewUrl(undefined));
  }, [preview]);

  const attachFiles = (paths: string[]) => {
    setFiles((current) => [...new Set([...current, ...paths.filter(Boolean)])]);
  };

  const chooseFiles = async () => {
    attachFiles(await window.ePi.app.chooseFiles());
  };

  const chooseFolder = async () => {
    const path = await window.ePi.app.chooseDirectory(cwd);
    if (path) attachFiles([path]);
  };

  const submit = async () => {
    const value = text.trim();
    if ((!value && files.length === 0 && !selectedSkill) || disabled || busy) return;
    const images = files.filter(isImage);
    const regular = files.filter((path) => !isImage(path));
    const prompt = [regular.map((path) => `Attached path: ${path}`).join("\n"), value].filter(Boolean).join("\n");
    const messages: string[] = [];
    if (selectedSkill && images.length === 0) {
      // pi natively loads the skill and appends the prompt as "User: <args>"
      messages.push([`/skill:${selectedSkill.name}`, prompt].filter(Boolean).join(" "));
    } else {
      if (selectedSkill) {
        // images go through /e-pi-attach (sendUserMessage), so load the skill natively first
        messages.push(`/skill:${selectedSkill.name}`);
      }
      if (images.length > 0) {
        const payload = btoa(
          unescape(
            encodeURIComponent(
              JSON.stringify({
                text: prompt,
                images,
              }),
            ),
          ),
        );
        messages.push(`/e-pi-attach ${payload}`);
      } else {
        messages.push(prompt);
      }
    }
    setSubmitting(true);
    const submitted = await onSubmit(messages).finally(() => setSubmitting(false));
    if (!submitted) return;
    setText("");
    setFiles([]);
    setSelectedSkill(undefined);
  };

  const changeModel = async (value: string) => {
    setPendingModel({ sessionPath, ref: value });
    const [provider, ...idParts] = value.split("/");
    const id = idParts.join("/");
    if (!provider || !id) return;
    try {
      setModels(await window.ePi.models.setDefault({ provider, id, sessionPath }));
    } catch {
      setPendingModel(undefined);
    }
  };

  const changeThinking = async (value: string) => {
    setThinking(value as ThinkingLevel);
    if (sessionPath) await window.ePi.runtime.submit(sessionPath, `/e-pi-thinking ${value}`);
  };

  return (
    <div
      className="composer-shell"
      data-dragging={dragging}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        attachFiles(Array.from(event.dataTransfer.files).map((file) => window.ePi.app.getPathForFile(file)));
      }}
    >
      {files.length > 0 || selectedSkill ? (
        <div className="composer-attachments" aria-label="Attached context">
          {selectedSkill ? (
            <span className="composer-attachment composer-skill" title={selectedSkill.description}>
              <Sparkles size={12} />
              <span>{selectedSkill.name}</span>
              <button
                type="button"
                onClick={() => setSelectedSkill(undefined)}
                aria-label={`Remove ${selectedSkill.name} skill`}
              >
                <X size={12} />
              </button>
            </span>
          ) : null}
          {files.map((path) => {
            const image = isImage(path);
            const thumb = image ? thumbnails[path] : undefined;
            return (
              <span className="composer-attachment" data-image={image ? "true" : undefined} key={path} title={path}>
                {image ? (
                  <button
                    type="button"
                    className="composer-attachment-thumb"
                    onClick={() => setPreview(path)}
                    aria-label={`Preview ${path}`}
                  >
                    {thumb ? <img src={thumb} alt="" /> : <File size={14} />}
                  </button>
                ) : (
                  <File size={12} />
                )}
                {!image ? (
                  <button
                    type="button"
                    className="composer-attachment-name"
                    onClick={() => image && setPreview(path)}
                    aria-label={image ? `Preview ${path}` : path}
                  >
                    <span>{path.split(/[\\/]/).pop()}</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setFiles((current) => current.filter((item) => item !== path))}
                  aria-label={`Remove ${path}`}
                >
                  <X size={12} />
                </button>
              </span>
            );
          })}
        </div>
      ) : null}
      <Dialog
        open={preview !== undefined}
        onOpenChange={(open) => {
          if (!open) setPreview(undefined);
        }}
      >
        <DialogContent className="max-w-[min(1100px,calc(100vw-4rem))] p-2 sm:max-w-none">
          <DialogTitle className="sr-only">Image preview</DialogTitle>
          {previewUrl ? (
            <img className="composer-preview-img" src={previewUrl} alt={preview?.split(/[\\/]/).pop() ?? "Preview"} />
          ) : null}
        </DialogContent>
      </Dialog>
      <Textarea
        aria-label="Message Pi"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onPaste={(event) => {
          const hasImage = Array.from(event.clipboardData.items).some(
            (item) => item.kind === "file" && item.type.startsWith("image/"),
          );
          if (!hasImage) return;
          event.preventDefault();
          void window.ePi.app
            .pasteImage()
            .then((path) => {
              if (path) attachFiles([path]);
            })
            .catch(() => undefined);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder="Ask Pi to inspect, change, or explain..."
        disabled={disabled || busy}
        rows={1}
      />
      <div className="composer-toolbar">
        <div className="composer-tools">
          <DropdownMenu
            onOpenChange={(open) => {
              if (open && cwd) {
                void window.ePi.skills
                  .list(cwd)
                  .then(setSkills)
                  .catch(() => setSkills([]));
              }
            }}
          >
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={disabled || busy}
                aria-label="Add context"
                title="Add context"
              >
                <Plus size={17} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="composer-add-menu" align="start">
              <DropdownMenuItem onSelect={() => void chooseFiles()}>
                <File size={15} />
                File
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void chooseFolder()}>
                <FolderOpen size={15} />
                Folder
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Sparkles size={15} />
                  Skill
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="composer-skill-menu">
                  {skills.length > 0 ? (
                    <DropdownMenuRadioGroup
                      value={selectedSkill?.filePath ?? ""}
                      onValueChange={(filePath) =>
                        setSelectedSkill(skills.find((skill) => skill.filePath === filePath))
                      }
                    >
                      {skills.map((skill) => (
                        <DropdownMenuRadioItem key={skill.filePath} value={skill.filePath} title={skill.description}>
                          {skill.name}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  ) : (
                    <DropdownMenuItem disabled>No skills available</DropdownMenuItem>
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="composer-divider" />
          <Menubar className="composer-config-menubar">
            <MenubarMenu>
              <MenubarTrigger className="composer-config-trigger">
                <span className="composer-config-values">
                  <strong>{selectedModelLabel}</strong>
                  <span>{selectedThinking?.label ?? "Medium"}</span>
                </span>
              </MenubarTrigger>
              <MenubarContent className="composer-config-menu" align="start">
                <MenubarGroup>
                  <MenubarSub>
                    <MenubarSubTrigger>Model</MenubarSubTrigger>
                    <MenubarSubContent className="composer-model-menu">
                      <MenubarRadioGroup value={modelRef} onValueChange={(value) => void changeModel(value)}>
                        {availableProviders.map((provider, index) => (
                          <MenubarGroup key={provider.id}>
                            {index > 0 ? <MenubarSeparator /> : null}
                            <MenubarLabel>{provider.name || provider.id}</MenubarLabel>
                            {provider.models.map((candidate) => (
                              <MenubarRadioItem
                                key={`${candidate.provider}/${candidate.id}`}
                                value={`${candidate.provider}/${candidate.id}`}
                              >
                                {displayModel(candidate)}
                              </MenubarRadioItem>
                            ))}
                          </MenubarGroup>
                        ))}
                      </MenubarRadioGroup>
                    </MenubarSubContent>
                  </MenubarSub>
                  <MenubarSub>
                    <MenubarSubTrigger>Thinking strength</MenubarSubTrigger>
                    <MenubarSubContent>
                      <MenubarRadioGroup value={thinking} onValueChange={(value) => void changeThinking(value)}>
                        {THINKING_LEVELS.map((level) => (
                          <MenubarRadioItem key={level.value} value={level.value}>
                            <span>{level.label}</span>
                            <small className="thinking-note">{level.note}</small>
                          </MenubarRadioItem>
                        ))}
                      </MenubarRadioGroup>
                    </MenubarSubContent>
                  </MenubarSub>
                </MenubarGroup>
              </MenubarContent>
            </MenubarMenu>
          </Menubar>
        </div>
        <div className="composer-actions">
          {usage ? (
            <SessionStats
              context={context}
              usage={usage}
              cacheHitRate={cacheHitRate}
              speed={speed}
              live={activity === "busy"}
            />
          ) : null}
          <Button
            className="composer-send"
            size="sm"
            data-action={showStop ? "stop" : "send"}
            onClick={showStop ? onInterrupt : () => void submit()}
            disabled={!showStop && (!hasContent || disabled || busy)}
            aria-label={showStop ? "Interrupt Pi" : "Send message"}
            title={showStop ? "Stop" : "Send"}
          >
            <span>{showStop ? "Stop" : "Send"}</span>
            {showStop ? <Square size={13} fill="currentColor" /> : <ArrowRight size={15} />}
          </Button>
        </div>
      </div>
    </div>
  );
}
