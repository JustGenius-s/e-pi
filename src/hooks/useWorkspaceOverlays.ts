import { useCallback, useRef, useState } from "react";

/**
 * Overlay state machine for the workspace code editor and file preview
 * (port of LiveAgent's useWorkspaceOverlays, without the SSH terminal).
 *
 * - mounted: the overlay exists in the DOM (mount/unmount cost);
 * - open: it is visible; opening one overlay closes the other (mutual
 *   exclusion);
 * - openRequest: monotonically id'ed request the overlay consumes to load a
 *   file; a new request id always re-reads even for the same path;
 * - closeRequestId: monotonically id'ed request to *really* close (runs the
 *   dirty-save confirmation when needed); closing runs the slide-out
 *   animation, then onClose unmounts.
 */

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
  }, []);

  const requestPreviewClose = useCallback(() => {
    setPreviewOpen(false);
  }, []);

  const handlePreviewClosed = useCallback(() => {
    setPreviewOpen(false);
    setPreviewMounted(false);
    setPreviewOpenRequest(null);
  }, []);

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
