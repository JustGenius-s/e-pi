/**
 * Module-level pub/sub for pushing text into the composer from panels that
 * live outside its subtree (built-in editor's "add selection to chat").
 * Mirrors attachmentsBus; the composer inserts the text at the caret.
 */

type InsertTextListener = (text: string) => void;

const listeners = new Set<InsertTextListener>();

/** Subscribe; returns an unsubscribe function (safe to call twice). */
export function onInsertComposerText(listener: InsertTextListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Ask the composer to insert `text` at the caret and focus the input. */
export function emitInsertComposerText(text: string): void {
  for (const listener of listeners) listener(text);
}
