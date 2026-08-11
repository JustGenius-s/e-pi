import { memo, useCallback } from "react";

import type {
  UseWorkspaceOverlaysResult,
  WorkspaceEditorOpenRequest,
  WorkspacePreviewOpenRequest,
} from "../../hooks/useWorkspaceOverlays";
import { WorkspaceCodeEditorOverlay } from "./WorkspaceCodeEditorOverlay";
import { WorkspaceFilePreviewOverlay } from "./WorkspaceFilePreviewOverlay";

interface WorkspaceOverlayHostProps {
  overlays: UseWorkspaceOverlaysResult;
  /** Session cwd (fallback for previews when the request is being torn down). */
  cwd: string;
  /** Open a workspace path (markdown links inside previews). */
  onOpenWorkspacePath: (absPath: string) => void;
}

/**
 * Mounts the mutually exclusive workspace overlays (code editor / file
 * preview) over the workspace column. The editor stays mounted while merely
 * hidden (preview took over) so dirty tabs survive; a real close drops it.
 */
export const WorkspaceOverlayHost = memo(function WorkspaceOverlayHost({
  overlays,
  cwd,
  onOpenWorkspacePath,
}: WorkspaceOverlayHostProps) {
  // Stable callbacks: the `overlays` object is rebuilt on every App render,
  // but the hook's functions keep their identity — binding them with
  // useCallback keeps the overlay children memoized so App re-renders never
  // reach (and re-mount) the preview/editor subtree.
  const { openFilePreview, openEditorFile, requestPreviewClose, handleEditorClosed, handlePreviewClosed } = overlays;
  const onPreviewFile = useCallback(
    (request: Omit<WorkspacePreviewOpenRequest, "id">) => openFilePreview(request),
    [openFilePreview],
  );
  const onOpenEditor = useCallback(
    (request: Omit<WorkspaceEditorOpenRequest, "id">) => openEditorFile(request),
    [openEditorFile],
  );
  const onRequestClose = useCallback(() => requestPreviewClose(), [requestPreviewClose]);
  const onEditorClose = useCallback(() => handleEditorClosed(), [handleEditorClosed]);
  const onPreviewClose = useCallback(() => handlePreviewClosed(), [handlePreviewClosed]);

  return (
    <>
      {overlays.editorMounted ? (
        <WorkspaceCodeEditorOverlay
          openRequest={overlays.editorOpenRequest}
          isOpen={overlays.editorOpen}
          closeRequestId={overlays.editorCloseRequestId}
          onPreviewFile={onPreviewFile}
          onClose={onEditorClose}
        />
      ) : null}
      {overlays.previewMounted ? (
        <WorkspaceFilePreviewOverlay
          openRequest={overlays.previewOpenRequest}
          isOpen={overlays.previewOpen}
          cwd={cwd}
          onOpenEditor={onOpenEditor}
          onOpenWorkspacePath={onOpenWorkspacePath}
          onRequestClose={onRequestClose}
          onClose={onPreviewClose}
        />
      ) : null}
    </>
  );
});
