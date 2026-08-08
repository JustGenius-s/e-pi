import {
  ChevronLeft,
  ChevronRight,
  FilePenLine,
  FileText,
  Loader2,
  MessageSquarePlus,
  Minus,
  Plus,
  RefreshCw,
  RotateCwSquare,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import type { WorkspaceEditorOpenRequest, WorkspacePreviewOpenRequest } from "../../hooks/useWorkspaceOverlays";
import { emitInsertComposerReference } from "../../lib/composerBus";
import { toRelativeWorkspacePath } from "../../lib/mentionReferences";
import { cn } from "../../lib/utils";
import {
  getWorkspacePreviewKind,
  isWorkspaceEditablePreviewPath,
  type WorkspacePreviewKind,
} from "../../lib/workspacePreviewKind";
import { WorkspaceMarkdownPreview } from "./WorkspaceMarkdownPreview";

const PREVIEW_ANIMATION_MS = 180;
const IMAGE_MIN_SCALE = 0.25;
const IMAGE_MAX_SCALE = 4;
const IMAGE_SCALE_STEP = 0.15;
const IMAGE_WHEEL_SCALE_STEP = 0.05;

function basename(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function toMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message;
  const text = String(error ?? "").trim();
  return text || fallback;
}

function base64ToBytes(data: string) {
  const binary = window.atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function kindFromMimeType(mimeType: string): WorkspacePreviewKind | null {
  const mime = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/html") return "html";
  if (mime === "text/markdown" || mime === "text/x-markdown") return "markdown";
  if (mime.startsWith("text/")) return "text";
  return null;
}

function resolvePreviewKind(path: string, mimeType: string): WorkspacePreviewKind {
  const mimeKind = kindFromMimeType(mimeType);
  if (mimeKind === "markdown" || mimeKind === "html" || mimeKind === "text") return mimeKind;
  return getWorkspacePreviewKind(path) ?? mimeKind ?? "text";
}

function decodePreviewText(bytes: Uint8Array) {
  return new TextDecoder("utf-8").decode(bytes);
}

function isTextPreviewKind(kind: WorkspacePreviewKind) {
  return kind === "html" || kind === "markdown" || kind === "text";
}

/**
 * Sandboxed HTML preview: the iframe has no allow-same-origin, so any
 * localStorage/sessionStorage access by the page throws. Install a shim
 * storage before the page scripts run so simple pages keep working.
 */
const SANDBOXED_HTML_PREVIEW_BOOTSTRAP = [
  "<script data-e-pi-html-preview-bootstrap>",
  "(() => {",
  "  function createStorage() {",
  "    const values = new Map();",
  "    const storage = {",
  "      get length() { return values.size; },",
  "      key(index) { return Array.from(values.keys())[Number(index)] ?? null; },",
  "      getItem(key) { key = String(key); return values.has(key) ? values.get(key) : null; },",
  "      setItem(key, value) { values.set(String(key), String(value)); },",
  "      removeItem(key) { values.delete(String(key)); },",
  "      clear() { values.clear(); },",
  "    };",
  "    return new Proxy(storage, {",
  "      get(target, key, receiver) {",
  "        if (typeof key !== 'string' || key in target) return Reflect.get(target, key, receiver);",
  "        return target.getItem(key);",
  "      },",
  "      set(target, key, value, receiver) {",
  "        if (typeof key !== 'string' || key in target) return Reflect.set(target, key, value, receiver);",
  "        target.setItem(key, value);",
  "        return true;",
  "      },",
  "      deleteProperty(target, key) {",
  "        if (typeof key === 'string') { target.removeItem(key); return true; }",
  "        return Reflect.deleteProperty(target, key);",
  "      },",
  "    });",
  "  }",
  "  for (const name of ['localStorage', 'sessionStorage']) {",
  "    try {",
  "      Object.defineProperty(window, name, { value: createStorage(), configurable: true });",
  "    } catch {}",
  "  }",
  "})();",
  "<\\/script>",
].join("");

function buildSandboxedHtmlPreviewSource(html: string) {
  const source = html.startsWith("\uFEFF") ? html.slice(1) : html;
  const headMatch = /<head(?:\s[^>]*)?>/i.exec(source);
  if (headMatch) {
    const insertionIndex = headMatch.index + headMatch[0].length;
    return `${source.slice(0, insertionIndex)}${SANDBOXED_HTML_PREVIEW_BOOTSTRAP}${source.slice(insertionIndex)}`;
  }
  const doctypeMatch = /^\s*<!doctype[^>]*>\s*/i.exec(source);
  const insertionIndex = doctypeMatch ? doctypeMatch[0].length : 0;
  return `${source.slice(0, insertionIndex)}${SANDBOXED_HTML_PREVIEW_BOOTSTRAP}${source.slice(insertionIndex)}`;
}

function clampImageScale(scale: number) {
  return Math.min(Math.max(scale, IMAGE_MIN_SCALE), IMAGE_MAX_SCALE);
}

function normalizeRotation(degrees: number) {
  const next = degrees % 360;
  return next < 0 ? next + 360 : next;
}

function normalizeImagePaths(paths: string[] | undefined, activePath: string) {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const path of paths ?? []) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    normalized.push(path);
  }
  if (activePath && !seen.has(activePath)) normalized.push(activePath);
  return normalized;
}

type LoadedPreview = {
  path: string;
  mimeType: string;
  sizeBytes: number;
  blobUrl: string;
  bytes: Uint8Array;
  kind: WorkspacePreviewKind;
  text: string | null;
};

interface WorkspaceFilePreviewOverlayProps {
  openRequest: WorkspacePreviewOpenRequest | null;
  isOpen: boolean;
  cwd: string;
  onOpenEditor: (request: Omit<WorkspaceEditorOpenRequest, "id">) => void;
  onOpenWorkspacePath: (absPath: string) => void;
  onRequestClose: () => void;
  onClose: () => void;
}

/**
 * Full-column preview overlay for workspace files (image / markdown / pdf /
 * text). Slides in over the workspace column; the preview and the code
 * editor are mutually exclusive (see useWorkspaceOverlays).
 */
export const WorkspaceFilePreviewOverlay = memo(function WorkspaceFilePreviewOverlay({
  openRequest,
  isOpen,
  cwd,
  onOpenEditor,
  onOpenWorkspacePath,
  onRequestClose,
  onClose,
}: WorkspaceFilePreviewOverlayProps) {
  const closeAnimationTimeoutRef = useRef<number | null>(null);
  const loadSequenceRef = useRef(0);
  const previewBlobUrlRef = useRef<string | null>(null);
  const previewRef = useRef<LoadedPreview | null>(null);
  const [preview, setPreview] = useState<LoadedPreview | null>(null);
  const [activeRequest, setActiveRequest] = useState<WorkspacePreviewOpenRequest | null>(null);
  const [imageTransitionDirection, setImageTransitionDirection] = useState<-1 | 0 | 1>(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  const replacePreview = useCallback((next: LoadedPreview | null) => {
    if (previewBlobUrlRef.current) URL.revokeObjectURL(previewBlobUrlRef.current);
    previewBlobUrlRef.current = next?.blobUrl ?? null;
    previewRef.current = next;
    setPreview(next);
  }, []);

  useEffect(
    () => () => {
      if (previewBlobUrlRef.current) {
        URL.revokeObjectURL(previewBlobUrlRef.current);
        previewBlobUrlRef.current = null;
      }
      previewRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (isOpen) {
      if (closeAnimationTimeoutRef.current !== null) {
        window.clearTimeout(closeAnimationTimeoutRef.current);
        closeAnimationTimeoutRef.current = null;
      }
      const frame = window.requestAnimationFrame(() => setIsVisible(true));
      return () => window.cancelAnimationFrame(frame);
    }
    setIsVisible(false);
    closeAnimationTimeoutRef.current = window.setTimeout(() => {
      closeAnimationTimeoutRef.current = null;
      onClose();
    }, PREVIEW_ANIMATION_MS);
  }, [isOpen, onClose]);

  useEffect(
    () => () => {
      if (closeAnimationTimeoutRef.current !== null) {
        window.clearTimeout(closeAnimationTimeoutRef.current);
      }
    },
    [],
  );

  const loadPreview = useCallback(
    async (request: WorkspacePreviewOpenRequest, transitionDirection: -1 | 0 | 1 = 0) => {
      const sequence = loadSequenceRef.current + 1;
      loadSequenceRef.current = sequence;
      const keepCurrentImage =
        transitionDirection !== 0 &&
        previewRef.current?.kind === "image" &&
        getWorkspacePreviewKind(request.path) === "image";
      setImageTransitionDirection(transitionDirection);
      setLoading(true);
      setError(null);
      setActiveRequest(request);
      if (!keepCurrentImage) replacePreview(null);
      try {
        const response = await window.ePi.fs.readWorkspaceBinary(request.cwd, request.path);
        if (loadSequenceRef.current !== sequence) return;
        const bytes = base64ToBytes(response.data);
        const kind = resolvePreviewKind(request.path, response.mimeType);
        const text = isTextPreviewKind(kind) ? decodePreviewText(bytes) : null;
        const blobBytes =
          kind === "html" && text !== null ? new TextEncoder().encode(buildSandboxedHtmlPreviewSource(text)) : bytes;
        const blob = new Blob([blobBytes.slice().buffer], { type: response.mimeType });
        const loaded: LoadedPreview = {
          path: request.path,
          mimeType: response.mimeType,
          sizeBytes: response.sizeBytes,
          blobUrl: URL.createObjectURL(blob),
          bytes,
          kind,
          text,
        };
        replacePreview(loaded);
      } catch (loadError) {
        if (loadSequenceRef.current !== sequence) return;
        if (!keepCurrentImage) replacePreview(null);
        setError(toMessage(loadError, "Failed to open file"));
      } finally {
        if (loadSequenceRef.current === sequence) setLoading(false);
      }
    },
    [replacePreview],
  );

  useEffect(() => {
    if (!openRequest) {
      setActiveRequest(null);
      return;
    }
    void loadPreview(openRequest, 0);
  }, [loadPreview, openRequest]);

  const activePreviewRequest = activeRequest ?? openRequest;
  const activePath = preview?.path ?? activePreviewRequest?.path ?? "";
  const kind = preview?.kind ?? (activePath ? getWorkspacePreviewKind(activePath) : null) ?? "text";
  const imagePaths = useMemo(
    () => (kind === "image" ? normalizeImagePaths(activePreviewRequest?.imagePaths, activePath) : []),
    [activePath, activePreviewRequest?.imagePaths, kind],
  );
  const canOpenEditor = Boolean(activePreviewRequest && isWorkspaceEditablePreviewPath(activePath));

  /** Attach a whole-file reference to the composer; tip on success. */
  const addPreviewToChat = useCallback(() => {
    if (!activePreviewRequest || !activePath) return;
    const handled = emitInsertComposerReference({
      path: toRelativeWorkspacePath(activePath, activePreviewRequest.cwd),
    });
    if (handled) toast.success("Added to chat");
  }, [activePreviewRequest, activePath]);

  const openImagePath = useCallback(
    (path: string, transitionDirection: -1 | 0 | 1 = 0) => {
      if (!activePreviewRequest || !path || path === activePath) return;
      void loadPreview({ ...activePreviewRequest, path }, transitionDirection);
    },
    [activePath, activePreviewRequest, loadPreview],
  );

  return (
    <div className={cn("workspace-file-preview-overlay", isVisible ? "visible" : "hidden")}>
      <div className="workspace-overlay-toolbar">
        <FileText className="workspace-overlay-toolbar-icon" />
        <div className="workspace-overlay-toolbar-titles">
          <div className="workspace-overlay-toolbar-title">File preview</div>
          <div className="workspace-overlay-toolbar-path">{activePath}</div>
        </div>
        <div className="workspace-overlay-toolbar-actions">
          {activePreviewRequest && activePath ? (
            <button
              type="button"
              className="workspace-overlay-tool-button"
              title="Add to chat"
              onClick={addPreviewToChat}
            >
              <MessageSquarePlus size={15} />
            </button>
          ) : null}
          {canOpenEditor && activePreviewRequest ? (
            <button
              type="button"
              className="workspace-overlay-tool-button"
              title="Edit"
              onClick={() =>
                onOpenEditor({
                  cwd: activePreviewRequest.cwd,
                  path: activePath || activePreviewRequest.path,
                })
              }
            >
              <FilePenLine size={15} />
            </button>
          ) : null}
          <button
            type="button"
            className="workspace-overlay-tool-button"
            title="Reload"
            disabled={!activePreviewRequest || loading}
            onClick={() => activePreviewRequest && void loadPreview(activePreviewRequest, 0)}
          >
            <RefreshCw size={15} className={loading ? "spin" : undefined} />
          </button>
          <button type="button" className="workspace-overlay-tool-button" title="Close" onClick={onRequestClose}>
            <X size={15} />
          </button>
        </div>
      </div>

      {error ? (
        <div className="workspace-overlay-error">
          <span className="truncate">{error}</span>
        </div>
      ) : null}

      <div className="workspace-preview-body">
        {preview ? (
          <PreviewBody
            preview={preview}
            cwd={cwd}
            activePath={activePath}
            imagePaths={imagePaths}
            transitionDirection={imageTransitionDirection}
            isSwitchingImage={loading && preview.kind === "image"}
            onOpenImagePath={openImagePath}
            onOpenWorkspacePath={onOpenWorkspacePath}
          />
        ) : loading ? (
          <div className="workspace-preview-empty">
            <Loader2 size={24} className="spin" />
          </div>
        ) : (
          <div className="workspace-preview-empty">
            <FileText size={26} />
          </div>
        )}
      </div>

      <div className="workspace-overlay-statusbar">
        <span className="truncate">{activePath}</span>
        {preview ? (
          <span className="shrink-0">
            {preview.mimeType} · {formatBytes(preview.sizeBytes)}
          </span>
        ) : null}
      </div>
    </div>
  );
});

function PreviewBody(props: {
  preview: LoadedPreview;
  cwd: string;
  activePath: string;
  imagePaths: string[];
  transitionDirection: -1 | 0 | 1;
  isSwitchingImage: boolean;
  onOpenImagePath: (path: string, direction?: -1 | 0 | 1) => void;
  onOpenWorkspacePath: (absPath: string) => void;
}) {
  const {
    preview,
    cwd,
    activePath,
    imagePaths,
    transitionDirection,
    isSwitchingImage,
    onOpenImagePath,
    onOpenWorkspacePath,
  } = props;

  if (preview.kind === "image") {
    return (
      <WorkspaceImagePreviewBody
        key={`${preview.path}:${preview.mimeType}`}
        activePath={activePath}
        imagePaths={imagePaths}
        transitionDirection={transitionDirection}
        isSwitchingImage={isSwitchingImage}
        preview={preview}
        onOpenImagePath={onOpenImagePath}
      />
    );
  }

  if (preview.kind === "pdf") {
    return (
      <iframe className="workspace-preview-iframe" sandbox="" src={preview.blobUrl} title={basename(preview.path)} />
    );
  }

  if (preview.kind === "html") {
    return (
      <iframe
        className="workspace-preview-iframe"
        sandbox="allow-scripts allow-forms allow-modals allow-pointer-lock allow-popups"
        src={preview.blobUrl}
        title={basename(preview.path)}
      />
    );
  }

  if (preview.kind === "markdown") {
    return (
      <div className="workspace-preview-scroll">
        <WorkspaceMarkdownPreview
          markdownPath={preview.path}
          cwd={cwd}
          content={preview.text ?? ""}
          className="workspace-preview-markdown"
          onOpenWorkspacePath={onOpenWorkspacePath}
        />
      </div>
    );
  }

  return (
    <div className="workspace-preview-scroll">
      <pre className="workspace-preview-text">{preview.text ?? ""}</pre>
    </div>
  );
}

function ImageToolButton(props: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  const { label, disabled, onClick, children } = props;
  return (
    <button
      type="button"
      className="workspace-overlay-tool-button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function WorkspaceImagePreviewBody(props: {
  preview: LoadedPreview;
  activePath: string;
  imagePaths: string[];
  transitionDirection: -1 | 0 | 1;
  isSwitchingImage: boolean;
  onOpenImagePath: (path: string, direction?: -1 | 0 | 1) => void;
}) {
  const { preview, activePath, imagePaths, transitionDirection, isSwitchingImage, onOpenImagePath } = props;
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [isEntering, setIsEntering] = useState(true);
  /** Drag-to-pan offset of the zoom box; only meaningful while scale > 1. */
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const zoomBoxRef = useRef<HTMLDivElement>(null);
  /** Active pointer-drag session: start position + the pan captured at pointerdown. */
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; panX: number; panY: number } | undefined>(
    undefined,
  );

  const activeImageIndex = imagePaths.indexOf(activePath);
  const imageCount = Math.max(imagePaths.length, 1);
  const imageNumber = activeImageIndex >= 0 ? activeImageIndex + 1 : 1;
  const canOpenPrevious = activeImageIndex > 0;
  const canOpenNext = activeImageIndex >= 0 && activeImageIndex < imagePaths.length - 1;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setIsEntering(false));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const openImageAt = (index: number) => {
    const path = imagePaths[index];
    if (!path) return;
    onOpenImagePath(path, index > activeImageIndex ? 1 : -1);
  };

  /**
   * Bound the pan so the zoomed box always covers the viewport center; the
   * image can never be dragged fully out of sight (and at scale ≤ 1 the box
   * fits, so the pan is forced back to 0 — centered).
   */
  const clampPan = useCallback((x: number, y: number): { x: number; y: number } => {
    const canvas = canvasRef.current;
    const box = zoomBoxRef.current;
    if (!canvas || !box) return { x: 0, y: 0 };
    const maxX = Math.max(0, (box.offsetWidth - canvas.clientWidth) / 2);
    const maxY = Math.max(0, (box.offsetHeight - canvas.clientHeight) / 2);
    return {
      x: Math.min(Math.max(x, -maxX), maxX),
      y: Math.min(Math.max(y, -maxY), maxY),
    };
  }, []);

  // Re-clamp after every zoom change (buttons or wheel): zooming back toward
  // 100% smoothly re-centers the image instead of leaving it off-screen.
  useEffect(() => {
    setPan((current) => clampPan(current.x, current.y));
  }, [scale, clampPan]);

  const resetZoom = () => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  };

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    // Pan only while zoomed in; at 100% or below the image fits centered.
    if (scale <= 1 || event.button !== 0) return;
    canvasRef.current?.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
    setDragging(true);
  };

  const moveDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPan(clampPan(drag.panX + (event.clientX - drag.startX), drag.panY + (event.clientY - drag.startY)));
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    setDragging(false);
  };

  return (
    <div className="workspace-image-preview-body">
      <div className="workspace-image-preview-toolbar">
        <div className="flex items-center gap-1">
          <ImageToolButton
            label="Previous image"
            disabled={!canOpenPrevious || isSwitchingImage}
            onClick={() => openImageAt(activeImageIndex - 1)}
          >
            <ChevronLeft size={15} />
          </ImageToolButton>
          <ImageToolButton
            label="Next image"
            disabled={!canOpenNext || isSwitchingImage}
            onClick={() => openImageAt(activeImageIndex + 1)}
          >
            <ChevronRight size={15} />
          </ImageToolButton>
          <span className="workspace-image-counter">
            {imageNumber}/{imageCount}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <ImageToolButton
            label="Zoom out"
            disabled={scale <= IMAGE_MIN_SCALE}
            onClick={() => setScale((current) => clampImageScale(current - IMAGE_SCALE_STEP))}
          >
            <Minus size={15} />
          </ImageToolButton>
          <button
            type="button"
            className="workspace-image-zoom"
            title="Reset zoom to 100%"
            disabled={scale === 1}
            onClick={resetZoom}
          >
            {Math.round(scale * 100)}%
          </button>
          <ImageToolButton
            label="Zoom in"
            disabled={scale >= IMAGE_MAX_SCALE}
            onClick={() => setScale((current) => clampImageScale(current + IMAGE_SCALE_STEP))}
          >
            <Plus size={15} />
          </ImageToolButton>
          <ImageToolButton label="Rotate" onClick={() => setRotation((current) => normalizeRotation(current + 90))}>
            <RotateCwSquare size={15} />
          </ImageToolButton>
        </div>
      </div>
      <div
        ref={canvasRef}
        className="workspace-image-canvas"
        data-pannable={scale > 1 ? "true" : undefined}
        data-dragging={dragging ? "true" : undefined}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={(event) => {
          if (event.deltaY === 0) return;
          event.preventDefault();
          const direction = event.deltaY < 0 ? 1 : -1;
          setScale((current) => clampImageScale(current + direction * IMAGE_WHEEL_SCALE_STEP));
        }}
      >
        {isSwitchingImage ? (
          <div className="workspace-image-switching">
            <Loader2 size={16} className="spin" />
          </div>
        ) : null}
        <div
          className="workspace-image-stage"
          style={{
            opacity: isEntering ? 0 : 1,
            transform: isEntering
              ? `translateX(${transitionDirection > 0 ? 18 : transitionDirection < 0 ? -18 : 0}px)`
              : "translateX(0)",
          }}
        >
          <div
            ref={zoomBoxRef}
            className="workspace-image-zoom-box"
            style={{
              height: `${scale * 100}%`,
              width: `${scale * 100}%`,
              transform: `translate(${pan.x}px, ${pan.y}px)`,
            }}
          >
            <img
              className="workspace-image-img"
              src={preview.blobUrl}
              alt={basename(preview.path)}
              draggable={false}
              style={{ transform: `rotate(${rotation}deg)` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
