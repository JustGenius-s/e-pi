import { ArrowUp, Brain, ImagePlus, Paperclip, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ModelManagementState, ModelRecord, PiProcessStatus } from "../types/contracts";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";

interface ComposerProps {
  status: PiProcessStatus;
  disabled: boolean;
  onSubmit: (text: string) => void;
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

function displayModel(model: ModelRecord): string {
  return model.name || model.id;
}

export function Composer({ status, disabled, onSubmit, onInterrupt }: ComposerProps) {
  const [text, setText] = useState("");
  const [models, setModels] = useState<ModelManagementState>();
  const [modelRef, setModelRef] = useState("");
  const [thinking, setThinking] = useState<ThinkingLevel>("medium");
  const [files, setFiles] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const busy = status === "starting" || status === "stopping";
  const availableModels =
    models?.providers.flatMap((provider) => provider.models.filter((model) => model.available)) ??
    [];

  useEffect(() => {
    window.ePi.models
      .list()
      .then((state) => {
        setModels(state);
        if (state.defaultModel)
          setModelRef(`${state.defaultModel.provider}/${state.defaultModel.id}`);
      })
      .catch(() => undefined);
  }, []);

  const attachFiles = async (paths: string[], imagesOnly = false) => {
    const valid = paths.filter((path) => !imagesOnly || /\.(png|jpe?g|gif|webp|bmp)$/i.test(path));
    setFiles((current) => [...new Set([...current, ...valid])]);
  };

  const chooseFiles = async (imagesOnly = false) => {
    const paths = await window.ePi.app.chooseFiles({ imagesOnly });
    await attachFiles(paths, imagesOnly);
  };

  const submit = async () => {
    const value = text.trim();
    if ((!value && files.length === 0) || disabled || busy) return;
    const images = files.filter((path) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(path));
    const regular = files.filter((path) => !images.includes(path));
    const prompt = [regular.map((path) => `Attached file: ${path}`).join("\n"), value]
      .filter(Boolean)
      .join("\n");
    if (files.length > 0) {
      const payload = btoa(
        unescape(encodeURIComponent(JSON.stringify({ text: prompt, files: [], images }))),
      );
      await window.ePi.runtime.submit(`/e-pi-attach ${payload}`);
    } else {
      onSubmit(prompt);
    }
    setText("");
    setFiles([]);
  };

  const changeModel = async (value: string) => {
    setModelRef(value);
    const [provider, ...idParts] = value.split("/");
    const id = idParts.join("/");
    if (provider && id) {
      try {
        await window.ePi.models.setDefault({ provider, id });
      } catch {
        /* settings panel reports auth errors */
      }
    }
  };

  const changeThinking = async (value: string) => {
    setThinking(value as ThinkingLevel);
    await window.ePi.runtime.submit(`/e-pi-thinking ${value}`);
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
        void attachFiles(
          Array.from(event.dataTransfer.files).map((file) => window.ePi.app.getPathForFile(file)),
        );
      }}
    >
      {files.length > 0 ? (
        <div className="composer-attachments" aria-label="Attachments">
          {files.map((path) => (
            <span className="composer-attachment" key={path}>
              <Paperclip size={12} />
              <span>{path.split(/[\\/]/).pop()}</span>
              <button
                type="button"
                onClick={() => setFiles((current) => current.filter((item) => item !== path))}
                aria-label={`Remove ${path}`}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <Textarea
        aria-label="Message Pi"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder={
          disabled
            ? "Select a session to start writing"
            : "Ask Pi to inspect, change, or explain..."
        }
        disabled={disabled || busy}
        rows={1}
      />
      <div className="composer-toolbar">
        <div className="composer-tools">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => void chooseFiles()}
            disabled={disabled || busy}
            title="Attach files"
          >
            <Paperclip size={14} />
            <span className="sr-only">Attach files</span>
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => void chooseFiles(true)}
            disabled={disabled || busy}
            title="Attach images"
          >
            <ImagePlus size={14} />
            <span className="sr-only">Attach images</span>
          </Button>
          <span className="composer-divider" />
          <Select value={modelRef} onValueChange={(value) => void changeModel(value)}>
            <SelectTrigger
              className="composer-select composer-model-select"
              size="sm"
              aria-label="Model"
            >
              <SelectValue placeholder="Model" />
            </SelectTrigger>
            <SelectContent>
              {availableModels.map((model) => (
                <SelectItem
                  key={`${model.provider}/${model.id}`}
                  value={`${model.provider}/${model.id}`}
                >
                  {displayModel(model)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={thinking} onValueChange={(value) => void changeThinking(value)}>
            <SelectTrigger
              className="composer-select composer-thinking-select"
              size="sm"
              aria-label="Thinking strength"
            >
              <Brain size={13} />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THINKING_LEVELS.map((level) => (
                <SelectItem key={level.value} value={level.value}>
                  <span>{level.label}</span>
                  <small className="thinking-note">{level.note}</small>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="composer-actions">
          {status === "running" ? (
            <Button
              className="composer-stop"
              variant="ghost"
              size="icon-sm"
              onClick={onInterrupt}
              aria-label="Interrupt Pi"
              title="Stop"
            >
              <Square size={13} fill="currentColor" />
            </Button>
          ) : null}
          <Button
            className="composer-send"
            size="sm"
            onClick={() => void submit()}
            disabled={(!text.trim() && files.length === 0) || disabled || busy}
            aria-label="Send message"
          >
            <ArrowUp size={15} />
            <span>Send</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
