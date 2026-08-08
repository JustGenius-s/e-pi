import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Overlay state machine for the workspace code editor and file preview
 * (port of LiveAgent's useWorkspaceOverlays, without the SSH terminal).
 *
 * - Mounted: the overlay exists in the DOM (mount/unmount cost);
 * - Open: it is visible; opening one overlay closes the other (mutual exclusion);
 * - OpenRequest: monotonically id'ed request the overlay consumes to load a file; a new request id always re-reads even
 *   for the same path;
 * - CloseRequestId: monotonically id'ed request to _really_ close (runs the dirty-save confirmation when needed); closing
 *   runs the slide-out animation, then onClose unmounts.
 *
 * Session persistence: the dev server fully reloads the page when workspace
 * source files are edited/saved; the open requests are mirrored to
 * sessionStorage so `restoreWorkspaceOverlays` can bring the overlays back
 * on boot. sessionStorage (not localStorage) keeps this restore-on-reload
 * only, never across app restarts.
 */

const EDITOR_STATE_KEY = "e-pi-workspace-editor-state";
const PREVIEW_STATE_KEY = "e-pi-workspace-preview-state";

type EditorStateSnapshot = {
  cwd: string;
  path: string;
  line?: number;
  endLine?: number;
};

type PreviewStateSnapshot = {
  cwd: string;
  path: string;
  imagePaths?: string[];
};

function writeSnapshot(key: string, snapshot: unknown): void {
  try {
    if (snapshot === null) {
      window.sessionStorage.removeItem(key);
    } else {
      window.sessionStorage.setItem(key, JSON.stringify(snapshot));
    }
  } catch {
    // Storage unavailable — restore-on-reload just won't happen.
  }
}

function readSnapshot<T>(key: string): T | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export interface WorkspaceEditorOpenRequest {
  id: number;
  cwd: string;
  /** Absolute path. */
  path: string;
  line?: number;
  endLine?: number;
}

export interface WorkspacePreviewOpenRequest {
  id: number;
  cwd: string;
  /** Absolute path. */
  path: string;
  /** Sibling image paths for prev/next navigation (same directory). */
  imagePaths?: string[];
}

export type UseWorkspaceOverlaysResult = {
  editorMounted: boolean;
  editorOpen: boolean;
  editorOpenRequest: WorkspaceEditorOpenRequest | null;
  editorCloseRequestId: number;
  openEditorFile: (request: Omit<WorkspaceEditorOpenRequest, "id">) => void;
  requestEditorClose: () => void;
  /** Close animation finished — drop editor state entirely. */
  handleEditorClosed: () => void;
  setEditorMounted: (mounted: boolean) => void;
  setEditorOpen: (open: boolean) => void;

  previewMounted: boolean;
  previewOpen: boolean;
  previewOpenRequest: WorkspacePreviewOpenRequest | null;
  openFilePreview: (request: Omit<WorkspacePreviewOpenRequest, "id">) => void;
  requestPreviewClose: () => void;
  handlePreviewClosed: () => void;
};

export function useWorkspaceOverlays(): UseWorkspaceOverlaysResult {
  const [editorMounted, setEditorMounted] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorOpenRequest, setEditorOpenRequest] = useState<WorkspaceEditorOpenRequest | null>(null);
  const [editorCloseRequestId, setEditorCloseRequestId] = useState(0);
  const editorRequestIdRef = useRef(0);
  const editorCloseRequestIdRef = useRef(0);

  const [previewMounted, setPreviewMounted] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewOpenRequest, setPreviewOpenRequest] = useState<WorkspacePreviewOpenRequest | null>(null);
  const previewRequestIdRef = useRef(0);

  const openEditorFile = useCallback((request: Omit<WorkspaceEditorOpenRequest, "id">) => {
    // Mutual exclusion: opening the editor hides the preview overlay.
    setPreviewOpen(false);
    editorRequestIdRef.current += 1;
    setEditorMounted(true);
    setEditorOpen(true);
    setEditorOpenRequest({ id: editorRequestIdRef.current, ...request });
  }, []);

  const openFilePreview = useCallback((request: Omit<WorkspacePreviewOpenRequest, "id">) => {
    // Mutual exclusion: opening the preview hides the editor overlay.
    setEditorOpen(false);
    previewRequestIdRef.current += 1;
    setPreviewMounted(true);
    setPreviewOpen(true);
    setPreviewOpenRequest({ id: previewRequestIdRef.current, ...request });
  }, []);

  const requestEditorClose = useCallback(() => {
    editorCloseRequestIdRef.current += 1;
    setEditorCloseRequestId(editorCloseRequestIdRef.current);
  }, []);

  const handleEditorClosed = useCallback(() => {
    setEditorOpen(false);
    setEditorMounted(false);
    setEditorOpenRequest(null);
    writeSnapshot(EDITOR_STATE_KEY, null);
  }, []);

  const requestPreviewClose = useCallback(() => {
    setPreviewOpen(false);
  }, []);

  const handlePreviewClosed = useCallback(() => {
    setPreviewOpen(false);
    setPreviewMounted(false);
    setPreviewOpenRequest(null);
    writeSnapshot(PREVIEW_STATE_KEY, null);
  }, []);

  // Keep the session snapshots in step with the open overlays (open → write,
  // close → clear) so a page reload can restore them.
  useEffect(() => {
    writeSnapshot(
      EDITOR_STATE_KEY,
      editorMounted && editorOpenRequest
        ? {
            cwd: editorOpenRequest.cwd,
            path: editorOpenRequest.path,
            line: editorOpenRequest.line,
            endLine: editorOpenRequest.endLine,
          }
        : null,
    );
  }, [editorMounted, editorOpenRequest]);

  useEffect(() => {
    writeSnapshot(
      PREVIEW_STATE_KEY,
      previewMounted && previewOpenRequest
        ? {
            cwd: previewOpenRequest.cwd,
            path: previewOpenRequest.path,
            imagePaths: previewOpenRequest.imagePaths,
          }
        : null,
    );
  }, [previewMounted, previewOpenRequest]);

  return {
    editorMounted,
    editorOpen,
    editorOpenRequest,
    editorCloseRequestId,
    openEditorFile,
    requestEditorClose,
    handleEditorClosed,
    setEditorMounted,
    setEditorOpen,
    previewMounted,
    previewOpen,
    previewOpenRequest,
    openFilePreview,
    requestPreviewClose,
    handlePreviewClosed,
  };
}

/** Restore the overlays persisted before a page reload (dev hot-reload). */
export function restoreWorkspaceOverlays(overlays: UseWorkspaceOverlaysResult): void {
  const editorSnapshot = readSnapshot<EditorStateSnapshot>(EDITOR_STATE_KEY);
  if (editorSnapshot?.cwd && editorSnapshot.path) {
    overlays.openEditorFile({
      cwd: editorSnapshot.cwd,
      path: editorSnapshot.path,
      line: editorSnapshot.line,
      endLine: editorSnapshot.endLine,
    });
  }
  const previewSnapshot = readSnapshot<PreviewStateSnapshot>(PREVIEW_STATE_KEY);
  if (previewSnapshot?.cwd && previewSnapshot.path) {
    overlays.openFilePreview({
      cwd: previewSnapshot.cwd,
      path: previewSnapshot.path,
      imagePaths: previewSnapshot.imagePaths,
    });
  }
}
