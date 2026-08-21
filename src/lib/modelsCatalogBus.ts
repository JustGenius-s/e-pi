/**
 * Notify the composer (and any other pickers) that the model catalog
 * changed — a custom provider was saved/removed, or credentials changed.
 * Settings holds its own copy of `models.list()`; the composer does too.
 */

const listeners = new Set<() => void>();

/** Subscribe; returns an unsubscribe function. */
export function onModelsCatalogChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tell listeners to re-fetch `models.list()`. */
export function emitModelsCatalogChanged(): void {
  for (const listener of listeners) listener();
}
