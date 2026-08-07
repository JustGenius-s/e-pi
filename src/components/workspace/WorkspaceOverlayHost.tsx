import { memo } from "react";

import type { UseWorkspaceOverlaysResult } from "../../hooks/useWorkspaceOverlays";
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
  return (
    <>
      {overlays.editorMounted ? (
        <WorkspaceCodeEditorOverlay
          openRequest={overlays.editorOpenRequest}
          isOpen={overlays.editorOpen}
          closeRequestId={overlays.editorCloseRequestId}
          onPreviewFile={(request) => overlays.openFilePreview(request)}
          onClose={overlays.handleEditorClosed}
        />
      ) : null}
      {overlays.previewMounted ? (
        <WorkspaceFilePreviewOverlay
          openRequest={overlays.previewOpenRequest}
          isOpen={overlays.previewOpen}
          cwd={cwd}
          onOpenEditor={(request) => overlays.openEditorFile(request)}
          onOpenWorkspacePath={onOpenWorkspacePath}
          onRequestClose={overlays.requestPreviewClose}
          onClose={overlays.handlePreviewClosed}
        />
      ) : null}
    </>
  );
});
