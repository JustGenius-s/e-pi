import { ArrowRight, File, FolderOpen, Plus, Sparkles, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type {
  CommandRecord,
  CommandSource,
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

/** Group labels for the command list, in display order. */
const COMMAND_GROUPS: Array<{ label: string; sources: CommandSource[] }> = [
  { label: "系统", sources: ["builtin"] },
  { label: "插件", sources: ["template", "plugin"] },
  { label: "技能", sources: ["skill"] },
];

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
  const [commands, setCommands] = useState<CommandRecord[]>([]);
  const [caret, setCaret] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [popupDismissed, setPopupDismissed] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const popupListRef = useRef<HTMLDivElement>(null);
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
  // Tracks the IME composition session ourselves: on macOS the Enter keydown
  // that commits a composition can arrive *after* compositionend with
  // isComposing already false (WebKit bug 165004, also observable in
  // Electron). The ref is reset one tick after compositionend (see the
  // textarea handler) so the commit-Enter is still swallowed, but a later
  // send-Enter is not.
  const composingRef = useRef(false);
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
    setCommands([]);
    if (!cwd) return;
    window.ePi.commands
      .list(cwd)
      .then(setCommands)
      .catch(() => setCommands([]));
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

  /**
   * Slash commands shown by the command-list popup: pi built-ins + prompt
   * templates (via commands IPC) + skills (already loaded for the "+" menu),
   * mirroring the autocomplete data pi's TUI feeds its editor. Deduped by
   * name — the first entry wins, matching the TUI's builtin-over-extension
   * precedence.
   */
  const allCommands = useMemo(() => {
    const seen = new Set<string>();
    const result: CommandRecord[] = [];
    for (const command of commands) {
      if (seen.has(command.name)) continue;
      seen.add(command.name);
      result.push(command);
    }
    for (const skill of skills) {
      const name = `skill:${skill.name}`;
      if (seen.has(name)) continue;
      seen.add(name);
      result.push({ name, description: skill.description, source: "skill" });
    }
    return result;
  }, [commands, skills]);

  /**
   * Command completion context, mirroring the TUI: the current line (from the
   * last newline to the caret) must start with "/" and contain no space yet.
   * The text after "/" up to the caret is the filter query.
   */
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const linePrefix = text.slice(lineStart, caret);
  const commandQuery = linePrefix.startsWith("/") && !linePrefix.includes(" ") ? linePrefix.slice(1) : null;

  const filteredCommands = useMemo(() => {
    if (commandQuery === null) return [];
    const query = commandQuery.toLowerCase();
    if (!query) return allCommands;
    const scored: Array<{ command: CommandRecord; score: number }> = [];
    for (const command of allCommands) {
      const name = command.name.toLowerCase();
      if (name.startsWith(query)) scored.push({ command, score: 0 });
      else if (name.includes(query)) scored.push({ command, score: 1 });
      else if ((command.description ?? "").toLowerCase().includes(query)) scored.push({ command, score: 2 });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.map((entry) => entry.command);
  }, [allCommands, commandQuery]);

  const popupOpen = inputFocused && commandQuery !== null && !popupDismissed && filteredCommands.length > 0;
  const clampedIndex = filteredCommands.length === 0 ? 0 : Math.min(selectedIndex, filteredCommands.length - 1);

  // Group the filtered list by label (系统/插件/技能), keeping the global
  // flattened index per group so keyboard navigation still walks all rows.
  const commandGroups = useMemo(() => {
    let offset = 0;
    const groups: Array<{ source: CommandSource; label: string; items: CommandRecord[]; start: number }> = [];
    for (const { label, sources } of COMMAND_GROUPS) {
      const items = filteredCommands.filter((command) => sources.includes(command.source));
      if (items.length === 0) continue;
      groups.push({ source: sources[0]!, label, items, start: offset });
      offset += items.length;
    }
    return groups;
  }, [filteredCommands]);

  // Anchor the popup just above the textarea. It lives in a portal (the shell
  // clips overflow), positioned with `bottom` so it grows upward like the
  // TUI's dropdown instead of covering the input.
  const [popupAnchor, setPopupAnchor] = useState<{ left: number; bottom: number; width: number }>();
  useEffect(() => {
    if (!popupOpen) {
      setPopupAnchor(undefined);
      return;
    }
    const measure = () => {
      const element = textareaRef.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      setPopupAnchor({
        // Bottom flush against the textarea, sides inset so the panel reads
        // narrower than the input.
        left: rect.left + 8,
        bottom: window.innerHeight - rect.top,
        width: rect.width - 16,
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [popupOpen, text]);

  // Re-point the selection at the top whenever the filter text changes.
  useEffect(() => {
    setSelectedIndex(0);
  }, [commandQuery]);

  // Keep the highlighted row in view while navigating.
  useEffect(() => {
    if (!popupOpen) return;
    const selected = popupListRef.current?.querySelector<HTMLElement>('[data-selected="true"]');
    selected?.scrollIntoView({ block: "nearest" });
  }, [clampedIndex, popupOpen]);

  const syncCaret = (element: HTMLTextAreaElement): void => {
    const next = element.selectionStart;
    if (next !== caret) setCaret(next);
  };

  /** Insert "/name " at the caret, replacing the typed prefix (TUI-style). */
  const acceptCommand = (command: CommandRecord): void => {
    const ta = textareaRef.current;
    const at = ta ? ta.selectionStart : caret;
    const start = text.lastIndexOf("\n", at - 1) + 1;
    const next = `${text.slice(0, start)}/${command.name} ${text.slice(at)}`;
    setText(next);
    setPopupDismissed(true);
    const nextCaret = start + command.name.length + 2;
    setCaret(nextCaret);
    requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (element) element.setSelectionRange(nextCaret, nextCaret);
    });
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
        ref={textareaRef}
        aria-label="Message Pi"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          syncCaret(event.target);
          setPopupDismissed(false);
        }}
        onSelect={(event) => syncCaret(event.currentTarget)}
        onClick={(event) => syncCaret(event.currentTarget)}
        onKeyUp={(event) => syncCaret(event.currentTarget)}
        onFocus={() => setInputFocused(true)}
        onBlur={() => setInputFocused(false)}
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
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          // Defer the reset one tick: the committing Enter keydown can arrive
          // right after this with isComposing already false.
          window.setTimeout(() => {
            composingRef.current = false;
          }, 0);
        }}
        onKeyDown={(event) => {
          // Enter during IME composition (e.g. Chinese pinyin) confirms the
          // candidate instead of sending. composingRef is the primary signal
          // (covers macOS, where the commit-Enter arrives after compositionend
          // with isComposing false); isComposing/keyCode 229 are fallbacks.
          const composing = composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
          // With the command list open, arrows move the selection and Enter/
          // Tab insert the highlighted command (TUI autocomplete behavior).
          if (popupOpen) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setSelectedIndex((index) => (index + 1) % filteredCommands.length);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setSelectedIndex((index) => (index - 1 + filteredCommands.length) % filteredCommands.length);
              return;
            }
            if (event.key === "Tab") {
              event.preventDefault();
              acceptCommand(filteredCommands[clampedIndex]!);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setPopupDismissed(true);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && !composing) {
              event.preventDefault();
              acceptCommand(filteredCommands[clampedIndex]!);
              return;
            }
          }
          if (event.key === "Enter" && !event.shiftKey && !composing) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder="Ask Pi to inspect, change, or explain..."
        disabled={disabled || busy}
        rows={1}
      />
      {popupOpen && popupAnchor
        ? createPortal(
            <div
              className="composer-command-popup"
              style={{ left: popupAnchor.left, bottom: popupAnchor.bottom, width: popupAnchor.width }}
              role="listbox"
              aria-label="Commands"
            >
              <div className="composer-command-list" ref={popupListRef}>
                {commandGroups.map((group) => (
                  <div className="composer-command-group" role="group" aria-label={group.label} key={group.source}>
                    <div className="composer-command-group-header">{group.label}</div>
                    {group.items.map((command, localIndex) => {
                      const index = group.start + localIndex;
                      const selected = index === clampedIndex;
                      return (
                        <button
                          key={`${command.source}:${command.name}`}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          data-selected={selected ? "true" : undefined}
                          className="composer-command-row"
                          onMouseDown={(event) => {
                            // Keep focus on the textarea so the popup context survives.
                            event.preventDefault();
                            acceptCommand(command);
                          }}
                        >
                          <span className="composer-command-name">/{command.name}</span>
                          {command.argumentHint ? (
                            <span className="composer-command-hint">{command.argumentHint}</span>
                          ) : null}
                          {command.description ? (
                            <span className="composer-command-desc">{command.description}</span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
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
