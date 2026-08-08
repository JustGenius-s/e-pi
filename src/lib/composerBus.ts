/**
 * Module-level pub/sub for attaching code/file references to the composer
 * from panels that live outside its subtree (built-in editor's "add
 * selection to chat", file preview's "add to chat"). The composer renders
 * them as graphical chips above the input and serializes them into the
 * outgoing message.
 *
 * Listeners return whether they handled the reference;
 * `emitInsertComposerReference` resolves to true when at least one listener
 * accepted it, so callers can show a success tip.
 */

import type { ComposerReference } from "./mentionReferences";

type InsertReferenceListener = (reference: ComposerReference) => boolean;

const listeners = new Set<InsertReferenceListener>();

/** Subscribe; returns an unsubscribe function (safe to call twice). */
export function onInsertComposerReference(listener: InsertReferenceListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Ask the composer to attach a reference (rendered as a chip above the
 * input). Returns true when at least one listener handled it (e.g. the
 * composer is mounted), false when nothing accepted it.
 */
export function emitInsertComposerReference(reference: ComposerReference): boolean {
  let handled = false;
  for (const listener of listeners) {
    if (listener(reference)) handled = true;
  }
  return handled;
}
