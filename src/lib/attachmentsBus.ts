/**
 * Tiny module-level pub/sub that lets any panel (e.g. the file tree's
 * right-click menu) push file/folder paths into the composer attachments.
 * The composer is mounted in a different branch of the tree, so a bus is
 * simpler than threading props through App/ToolPanel.
 */

type AttachFilesListener = (paths: string[]) => void;

const listeners = new Set<AttachFilesListener>();

/** Subscribe; returns an unsubscribe function (safe to call twice). */
export function onAttachFiles(listener: AttachFilesListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Notify the composer that the user wants these paths attached. */
export function emitAttachFiles(paths: string[]): void {
  for (const listener of listeners) listener(paths);
}
