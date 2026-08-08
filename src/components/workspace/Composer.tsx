import { ArrowRight, File, FileCode2, FileText, FolderOpen, Plus, Sparkles, Square, X, Zap } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
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
} from "@/components/ui/dropdown-menu";
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
} from "@/components/ui/menubar";
import { Textarea } from "@/components/ui/textarea";

import { useComposerCommands, type CommandPopupItem } from "../../hooks/useComposerCommands";
import { useComposerHistory } from "../../hooks/useComposerHistory";
import { useImeComposition } from "../../hooks/useImeComposition";
import { useModelVisibility } from "../../hooks/useModelVisibility";
import { useQuickCommands } from "../../hooks/useQuickCommands";
import { onAttachFiles } from "../../lib/attachmentsBus";
import { onInsertComposerReference } from "../../lib/composerBus";
import {
  composerReferenceKey,
  codeMentionDisplayName,
  codeMentionLineLabel,
  serializeComposerReferences,
  type ComposerReference,
} from "../../lib/mentionReferences";
import type { QuickCommand } from "../../lib/quickCommands";
import {
  createTextAttachment,
  formatAttachmentSize,
  serializeTextAttachments,
  shouldAttachAsTextAttachment,
  type ComposerTextAttachment,
} from "../../lib/textAttachments";
import type {
  AgentThinkingLevel,
  CommandArgumentOption,
  CommandRecord,
  ContextUsageState,
  ModelManagementState,
  ModelRecord,
  ModelRef,
  PiActivityStatus,
  PiProcessStatus,
  SessionUsageState,
  SkillRecord,
} from "../../types/contracts";
import { ComposerAttachments } from "./ComposerAttachments";
import { ComposerCommandPopup } from "./ComposerCommandPopup";
import { SessionStats } from "./SessionStats";

interface ComposerProps {
  sessionPath?: string;
  /** Undefined while the session's runtime has not reported in yet (freshly switched/new session). */
  status?: PiProcessStatus;
  activity?: PiActivityStatus;
  model?: ModelRef;
  /** Actual thinking level of the session's pi process, reported via the bridge. */
  thinkingLevel?: ThinkingLevel;
  /** Levels the current model supports; drives the menu (mirrors pi's Shift+Tab). */
  supportedThinkingLevels?: ThinkingLevel[];
  context?: ContextUsageState;
  usage?: SessionUsageState;
  cacheHitRate?: number;
  speed?: number;
  disabled: boolean;
  cwd?: string;
  /**
   * Changes trigger a focus of the input box. App passes the active session
   * path once its runtime is ready, so switching sessions or starting a new
   * one lands the user directly in the composer.
   */
  focusRequest?: string;
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

export const Composer = memo(function Composer({
  sessionPath,
  status,
  activity,
  model,
  thinkingLevel: reportedThinkingLevel,
  supportedThinkingLevels,
  context,
  usage,
  cacheHitRate,
  speed,
  disabled,
  cwd,
  focusRequest,
  onSubmit,
  onInterrupt,
}: ComposerProps) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [models, setModels] = useState<ModelManagementState>();
  const [pendingModel, setPendingModel] = useState<{ sessionPath?: string; ref: string }>();
  const [thinking, setThinking] = useState<ThinkingLevel>("medium");
  // Keep the selector in sync with the actual session level (initial launch
  // default, Shift+Tab in pi, /thinking, model switches). Until the bridge
  // reports a level the session keeps the composer's "medium" placeholder.
  useEffect(() => {
    if (reportedThinkingLevel) setThinking(reportedThinkingLevel);
  }, [reportedThinkingLevel]);
  const [files, setFiles] = useState<string[]>([]);
  /** Code/file references attached from the editor/preview; graphical chips. */
  const [references, setReferences] = useState<ComposerReference[]>([]);
  /** Large pasted text, shown as summary chips instead of flooding the input. */
  const [textAttachments, setTextAttachments] = useState<ComposerTextAttachment[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<string>();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<SkillRecord>();
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const { onCompositionStart, onCompositionEnd, isComposing } = useImeComposition();
  // Sent-message history, recalled with ArrowUp/ArrowDown (per project).
  const { push: pushHistory, stepUp: historyStepUp, stepDown: historyStepDown } = useComposerHistory(cwd);
  const busy = status === "starting" || status === "stopping" || submitting;
  const hasContent = Boolean(
    text.trim() || files.length > 0 || references.length > 0 || textAttachments.length > 0 || selectedSkill,
  );
  /** Quick commands: user-defined one-click prompts (Settings → Composer). */
  const quickCommands = useQuickCommands();
  const visibleQuickCommands = useMemo(
    () =>
      quickCommands.enabled
        ? quickCommands.commands.filter((command) => command.name.trim() && command.prompt.trim())
        : [],
    [quickCommands],
  );
  // Floating row above the input, only while it is empty (and the session
  // can take input). Clicking sends the prompt directly.
  const showQuickCommands = visibleQuickCommands.length > 0 && text.trim() === "" && !disabled && !busy;
  // Session loading: runtime not reported yet, or the pi process is still
  // booting. The model/thinking values come from the bridge's sidecar, so they
  // are unknown until the session is ready — show a loading label instead of
  // a misleading default.
  const sessionLoading = status === undefined || status === "starting" || status === "stopping";
  const modelLoading = sessionLoading && !model;

  // Session switches and freshly started sessions hand focus back to the
  // composer so the user can type immediately. The terminal only keeps focus
  // for trust prompts while a new session is still starting; once it reports
  // running this effect takes over (focusRequest flips from undefined).
  useEffect(() => {
    if (!focusRequest || disabled || busy) return;
    textareaRef.current?.focus();
  }, [focusRequest, disabled, busy]);
  // The bridge reports busy/idle through a sidecar file watched by the main
  // process. No data-stream fallback here: pi's TUI also writes output while
  // idle (status line refreshes, cursor), so stream activity cannot
  // distinguish "a task is running" from "the terminal is alive" — it would
  // flip the button to Stop for no reason.
  const taskActive = status === "running" && activity === "busy";
  // The button is context-driven, not task-state-driven: while a task runs
  // the user may still type and queue another message, so any input content
  // shows Send; an empty input shows Stop (interrupt the running task). When
  // idle, Send is shown but disabled until there is content.
  const showStop = taskActive && !hasContent;
  const sendEnabled = !disabled && !busy && hasContent;
  /** Models the user hid in Settings → Models are excluded from the picker. */
  const isModelHidden = useModelVisibility();
  const availableProviders =
    models?.providers
      .map((provider) => ({
        ...provider,
        models: provider.models.filter(
          (candidate) => candidate.available && !isModelHidden(`${candidate.provider}/${candidate.id}`),
        ),
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
  const selectedModelLabel = selectedModel
    ? displayModel(selectedModel)
    : modelLoading
      ? "Loading model…"
      : (model?.id ?? "Model");
  const selectedThinking = THINKING_LEVELS.find((level) => level.value === thinking);
  // Only offer levels the current model actually supports, so picking one never
  // gets silently re-clamped (and then re-synced) by the running pi process.
  const thinkingOptions =
    supportedThinkingLevels && supportedThinkingLevels.length > 0
      ? THINKING_LEVELS.filter((level) => supportedThinkingLevels.includes(level.value))
      : THINKING_LEVELS;
  const {
    activeItems,
    activeGroups,
    argumentLoading,
    popupOpen,
    clampedIndex,
    popupAnchor,
    popupListRef,
    caret,
    setCaret,
    setInputFocused,
    dismissPopup,
    setSelectedIndex,
    syncCaret,
  } = useComposerCommands({ cwd, text, skills, textareaRef });

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

  const attachFiles = useCallback((paths: string[]) => {
    setFiles((current) => [...new Set([...current, ...paths.filter(Boolean)])]);
  }, []);

  // Panels outside the composer tree (file tree context menu) can attach
  // files/folders through the attachments bus.
  useEffect(() => onAttachFiles(attachFiles), [attachFiles]);

  // The built-in editor / file preview attach code/file references here;
  // they render as chips above the input and are serialized on send.
  // Returning true lets the caller show an "Added to chat" tip.
  useEffect(() => {
    return onInsertComposerReference((reference) => {
      if (!textareaRef.current) return false;
      const key = composerReferenceKey(reference);
      setReferences((current) =>
        current.some((item) => composerReferenceKey(item) === key) ? current : [...current, reference],
      );
      return true;
    });
  }, []);

  const chooseFiles = async () => {
    attachFiles(await window.ePi.app.chooseFiles());
  };

  const chooseFolder = async () => {
    const path = await window.ePi.app.chooseDirectory(cwd);
    if (path) attachFiles([path]);
  };

  const submit = async () => {
    const value = text.trim();
    if (
      (!value && files.length === 0 && !selectedSkill && references.length === 0 && textAttachments.length === 0) ||
      disabled ||
      busy
    )
      return;
    const images = files.filter(isImage);
    const regular = files.filter((path) => !isImage(path));
    const referenceText = references.length > 0 ? serializeComposerReferences(references, cwd ?? "") : "";
    const attachmentText = textAttachments.length > 0 ? serializeTextAttachments(textAttachments) : "";
    const prompt = [referenceText, attachmentText, regular.map((path) => `Attached path: ${path}`).join("\n"), value]
      .filter(Boolean)
      .join("\n");
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
    // Keep the raw input (minus attachments/skill wrappers) for ArrowUp recall.
    pushHistory(text);
    // Normal send behavior: clear the input. Keep the focus in the box so
    // the user can immediately type the next message (empty input while a
    // task runs also flips the button back to Stop).
    setText("");
    setFiles([]);
    setReferences([]);
    setTextAttachments([]);
    setSelectedSkill(undefined);
    textareaRef.current?.focus();
  };

  /** Detach one text-attachment chip. */
  const removeTextAttachment = (id: string) => {
    setTextAttachments((current) => current.filter((attachment) => attachment.id !== id));
  };

  /** Detach one reference chip. */
  const removeReference = (reference: ComposerReference) => {
    const key = composerReferenceKey(reference);
    setReferences((current) => current.filter((item) => composerReferenceKey(item) !== key));
  };

  /** Send a quick command's prompt directly (the input is empty by definition). */
  const runQuickCommand = async (command: QuickCommand) => {
    const prompt = command.prompt.trim();
    if (!prompt || disabled || busy) return;
    setSubmitting(true);
    const submitted = await onSubmit([prompt]).finally(() => setSubmitting(false));
    if (!submitted) return;
    pushHistory(prompt);
    textareaRef.current?.focus();
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
    // Persist the choice as the default so future launches start at the same
    // level (mirrors the model selector, which updates the default too).
    try {
      const config = await window.ePi.agent.getConfig();
      await window.ePi.agent.saveConfig({ config: { ...config, thinkingLevel: value as AgentThinkingLevel } });
    } catch {
      // Non-fatal: the running session still applies the level.
    }
  };

  /** Insert "/name " at the caret, replacing the typed prefix (TUI-style). */
  const acceptCommand = (command: CommandRecord): void => {
    const ta = textareaRef.current;
    const at = ta ? ta.selectionStart : caret;
    const start = text.lastIndexOf("\n", at - 1) + 1;
    const next = `${text.slice(0, start)}/${command.name} ${text.slice(at)}`;
    setText(next);
    const nextCaret = start + command.name.length + 2;
    setCaret(nextCaret);
    requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (element) element.setSelectionRange(nextCaret, nextCaret);
    });
  };

  /** Replace the argument prefix with the selected option (TUI-style). */
  const acceptArgument = (option: CommandArgumentOption): void => {
    const ta = textareaRef.current;
    const at = ta ? ta.selectionStart : caret;
    const lineStart = text.lastIndexOf("\n", at - 1) + 1;
    const line = text.slice(lineStart, at);
    const spaceIndex = line.indexOf(" ");
    if (spaceIndex === -1) return;
    const argumentStart = lineStart + spaceIndex + 1;
    // Trailing space so the user can keep typing after the accepted value.
    const next = `${text.slice(0, argumentStart)}${option.value} ${text.slice(at)}`;
    setText(next);
    const nextCaret = argumentStart + option.value.length + 1;
    setCaret(nextCaret);
    requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (element) element.setSelectionRange(nextCaret, nextCaret);
    });
  };

  /** Accept a popup item: command or argument. */
  const acceptItem = (item: CommandPopupItem): void => {
    if (item.kind === "command") acceptCommand(item.command);
    else acceptArgument(item.option);
  };

  /** Accept whatever is selected in the popup. */
  const acceptSelected = (): void => {
    const item = activeItems[clampedIndex];
    if (item) acceptItem(item);
  };

  return (
    <div className="composer-wrap">
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
        <ComposerAttachments
          files={files}
          thumbnails={thumbnails}
          selectedSkill={selectedSkill}
          onPreview={setPreview}
          onRemoveFile={(path) => setFiles((current) => current.filter((item) => item !== path))}
          onRemoveSkill={() => setSelectedSkill(undefined)}
        />
        {textAttachments.length > 0 || references.length > 0 ? (
          <div className="composer-references" aria-label="References">
            {textAttachments.map((attachment) => (
              <span className="composer-text-attachment" key={attachment.id} title={attachment.text}>
                <FileText size={12} />
                <span className="composer-reference-name">{attachment.title}</span>
                <span className="composer-text-attachment-meta">
                  {attachment.lineCount} lines · {formatAttachmentSize(attachment.charCount)} chars
                </span>
                <button
                  type="button"
                  onClick={() => removeTextAttachment(attachment.id)}
                  aria-label="Remove text attachment"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
            {references.map((reference) => {
              const key = composerReferenceKey(reference);
              const hasLines = reference.startLine !== undefined && reference.endLine !== undefined;
              return (
                <span className="composer-reference" key={key} title={reference.path}>
                  <FileCode2 size={12} />
                  <span className="composer-reference-name">{codeMentionDisplayName(reference)}</span>
                  {hasLines ? (
                    <span className="composer-reference-lines">
                      {codeMentionLineLabel({ startLine: reference.startLine!, endLine: reference.endLine! })}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => removeReference(reference)}
                    aria-label={`Remove ${reference.path}`}
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
          }}
          onSelect={(event) => syncCaret(event.currentTarget)}
          onClick={(event) => syncCaret(event.currentTarget)}
          onKeyUp={(event) => syncCaret(event.currentTarget)}
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
          onPaste={(event) => {
            const items = Array.from(event.clipboardData.items);
            // Pixels (screenshot/browser copy) or a copied file (Finder/WeCom
            // expose a file URL, not pixels — the main process resolves both).
            const hasFile = items.some((item) => item.kind === "file");
            if (hasFile) {
              event.preventDefault();
              void window.ePi.app
                .pasteImage()
                .then((path) => {
                  if (path) attachFiles([path]);
                })
                .catch(() => undefined);
              return;
            }
            // Large pasted text becomes a summary chip instead of flooding
            // the input; small pastes keep the normal caret insertion.
            const pastedText = event.clipboardData.getData("text/plain");
            if (shouldAttachAsTextAttachment(pastedText)) {
              event.preventDefault();
              setTextAttachments((current) => [...current, createTextAttachment(pastedText)]);
            }
          }}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          onKeyDown={(event) => {
            // Enter during IME composition (e.g. Chinese pinyin) confirms the
            // candidate instead of sending. composingRef is the primary signal
            // (covers macOS, where the commit-Enter arrives after compositionend
            // with isComposing false); isComposing/keyCode 229 are fallbacks.
            const composing = isComposing(event);
            // With the command list open, arrows move the selection and Enter/
            // Tab insert the highlighted command (TUI autocomplete behavior).
            if (popupOpen) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelectedIndex((index) => (index + 1) % activeItems.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelectedIndex((index) => (index - 1 + activeItems.length) % activeItems.length);
                return;
              }
              if (event.key === "Tab") {
                event.preventDefault();
                acceptSelected();
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                dismissPopup();
                return;
              }
              if (event.key === "Enter" && !event.shiftKey && !composing) {
                event.preventDefault();
                acceptSelected();
                return;
              }
            }
            // ArrowUp/ArrowDown recall previously sent messages. Guarded against
            // IME composition (the popup above already owns the arrows while
            // open); step* return undefined when the key should behave normally.
            if (event.key === "ArrowUp" && !composing) {
              const entry = historyStepUp(text);
              if (entry !== undefined) {
                event.preventDefault();
                setText(entry);
                setCaret(entry.length);
                requestAnimationFrame(() => {
                  const element = textareaRef.current;
                  if (element) element.setSelectionRange(entry.length, entry.length);
                });
                return;
              }
            }
            if (event.key === "ArrowDown" && !composing) {
              const entry = historyStepDown();
              if (entry !== undefined) {
                event.preventDefault();
                setText(entry);
                setCaret(entry.length);
                requestAnimationFrame(() => {
                  const element = textareaRef.current;
                  if (element) element.setSelectionRange(entry.length, entry.length);
                });
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
        {popupOpen ? (
          <ComposerCommandPopup
            groups={activeGroups}
            selectedIndex={clampedIndex}
            anchor={popupAnchor}
            listRef={popupListRef}
            loading={argumentLoading}
            onAccept={acceptItem}
          />
        ) : null}
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
            <Menubar className="composer-config-menubar">
              <MenubarMenu>
                <MenubarTrigger className="composer-config-trigger">
                  <span className="composer-config-values">
                    <strong className={modelLoading ? "composer-config-loading" : undefined}>
                      {selectedModelLabel}
                    </strong>
                    <span>{modelLoading ? "…" : (selectedThinking?.label ?? "Medium")}</span>
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
                          {thinkingOptions.map((level) => (
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
              disabled={!showStop && !sendEnabled}
              aria-label={showStop ? "Interrupt Pi" : "Send message"}
              title={showStop ? "Stop" : "Send"}
            >
              <span>{showStop ? "Stop" : "Send"}</span>
              {showStop ? <Square size={13} fill="currentColor" /> : <ArrowRight size={15} />}
            </Button>
          </div>
        </div>
      </div>
      {/* Floating above the card's top border, outside the card so the
          shell's overflow:hidden (rounded corners) can't clip it. */}
      {showQuickCommands ? (
        <div className="composer-quick-commands" role="toolbar" aria-label="Quick commands">
          {visibleQuickCommands.map((command) => (
            <button
              key={command.id}
              type="button"
              className="composer-quick-command"
              title={command.prompt}
              onClick={() => void runQuickCommand(command)}
            >
              <Zap size={11} />
              <span>{command.name}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
});
