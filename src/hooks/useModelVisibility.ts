import { useCallback, useSyncExternalStore } from "react";

import { getModelVisibilitySnapshot, isModelHiddenInState, subscribeModelVisibility } from "../lib/modelVisibility";

/**
 * Live model-visibility predicate: `isHidden("provider/id")`.
 *
 * The snapshot is the state object itself (a new reference whenever the
 * store persists), so React re-renders on every visibility change — a stable
 * function reference as snapshot would never change and the toggle would
 * appear dead. Shared with the Settings model list: toggling there
 * re-renders the composer's picker immediately.
 */
export function useModelVisibility(): (ref: string) => boolean {
  const state = useSyncExternalStore(subscribeModelVisibility, getModelVisibilitySnapshot, getModelVisibilitySnapshot);
  return useCallback((ref: string) => isModelHiddenInState(state, ref), [state]);
}
