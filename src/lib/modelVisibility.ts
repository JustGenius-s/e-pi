/**
 * Model visibility: which models show up in the composer's model picker.
 *
 * Three sources decide, in order:
 * 1. Explicitly hidden refs (`provider/id`) — the user turned the switch off.
 * 2. Explicitly shown refs — the user turned the switch on.
 * 3. Providers that were configured with a key: their models are hidden BY
 * DEFAULT, so a freshly configured provider doesn't flood the picker —
 * the user turns individual models on. Marking is idempotent and never
 * overrides an explicit choice.
 *
 * So a model is hidden when it is explicitly hidden, OR its provider is
 * default-hidden AND the user never explicitly showed it. Stored in
 * localStorage and shared through a module-level store with subscribers
 * (mirrors quickCommands).
 */

export interface ModelVisibilityState {
  /** Model refs (`provider/id`) the user explicitly showed. */
  shown: string[];
  /** Model refs the user explicitly hid. */
  hidden: string[];
  /** Provider ids configured with a key; their models start hidden. */
  defaultHiddenProviders: string[];
}

export const MODEL_VISIBILITY_STORAGE_KEY = "model-visibility-v1";
/** Legacy key (v1 of the feature stored a plain hidden-ref array). */
const MODEL_HIDDEN_STORAGE_KEY = "model-hidden-v1";

/** Model refs must look like `provider/id`. */
function isModelRef(value: unknown): value is string {
  return typeof value === "string" && value.includes("/") && value.length > 1;
}

/** Validate/coerce untrusted (stored) state. */
export function normalizeModelVisibility(value: unknown): ModelVisibilityState {
  const raw = (value ?? {}) as Partial<ModelVisibilityState>;
  return {
    shown: (Array.isArray(raw.shown) ? raw.shown : []).filter(isModelRef),
    hidden: (Array.isArray(raw.hidden) ? raw.hidden : []).filter(isModelRef),
    defaultHiddenProviders: (Array.isArray(raw.defaultHiddenProviders) ? raw.defaultHiddenProviders : []).filter(
      (item) => typeof item === "string" && item.length > 0,
    ),
  };
}

/** Provider part of a model ref (safe when the provider id itself contains slashes). */
function providerOf(ref: string): string {
  return ref.slice(0, ref.lastIndexOf("/"));
}

interface ModelVisibilityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Test seam: point the store at a mock instead of window.localStorage. */
let storageOverride: ModelVisibilityStorage | undefined;
export function setModelVisibilityStorage(storage: ModelVisibilityStorage | undefined): void {
  storageOverride = storage;
}

function resolveStorage(): ModelVisibilityStorage | null {
  if (storageOverride) return storageOverride;
  if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  return null;
}

let cached: ModelVisibilityState | undefined;
const listeners = new Set<() => void>();

/** Shared empty state so getSnapshot stays referentially stable without storage. */
const EMPTY_STATE: ModelVisibilityState = { shown: [], hidden: [], defaultHiddenProviders: [] };

export function getModelVisibility(): ModelVisibilityState {
  if (cached) return cached;
  const store = resolveStorage();
  if (!store) {
    cached = EMPTY_STATE;
    return cached;
  }
  try {
    const raw = store.getItem(MODEL_VISIBILITY_STORAGE_KEY);
    if (raw) {
      cached = normalizeModelVisibility(JSON.parse(raw));
      return cached;
    }
    // Migrate the legacy `model-hidden-v1` array into the new state.
    const legacy = store.getItem(MODEL_HIDDEN_STORAGE_KEY);
    if (legacy) {
      const legacyRaw: unknown = JSON.parse(legacy);
      const migrated = normalizeModelVisibility({ hidden: Array.isArray(legacyRaw) ? legacyRaw : [] });
      cached = migrated;
      store.setItem(MODEL_VISIBILITY_STORAGE_KEY, JSON.stringify(migrated));
      return cached;
    }
  } catch {
    // Corrupted storage — fall through to empty defaults.
  }
  cached = EMPTY_STATE;
  return cached;
}

/** Persist the state and notify every subscriber (composer + settings). */
function persist(next: ModelVisibilityState): void {
  cached = next;
  const store = resolveStorage();
  if (store) {
    try {
      store.setItem(MODEL_VISIBILITY_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage unavailable — the change just won't survive a restart.
    }
  }
  for (const listener of listeners) listener();
}

/** Stable snapshot getter for useSyncExternalStore (module-level function). */
export function getModelVisibilitySnapshot(): ModelVisibilityState {
  return getModelVisibility();
}

/** Pure predicate over an explicit state (exported for hooks and tests). */
export function isModelHiddenInState(state: ModelVisibilityState, ref: string): boolean {
  if (state.hidden.includes(ref)) return true;
  if (!state.defaultHiddenProviders.includes(providerOf(ref))) return false;
  return !state.shown.includes(ref);
}

/** Is this model ref hidden from the picker (current stored state)? */
export function isModelHidden(ref: string): boolean {
  return isModelHiddenInState(getModelVisibility(), ref);
}

/**
 * Explicitly show (hidden=false) or hide (hidden=true) a model. The choice
 * sticks even when the provider's default-hidden marking changes later.
 * Returns the new hidden state.
 */
export function setModelHidden(ref: string, hidden: boolean): boolean {
  const current = getModelVisibility();
  const next = {
    shown: current.shown.filter((item) => item !== ref),
    hidden: current.hidden.filter((item) => item !== ref),
    defaultHiddenProviders: current.defaultHiddenProviders,
  };
  if (hidden) next.hidden.push(ref);
  else next.shown.push(ref);
  if (current.shown.length === next.shown.length && current.hidden.length === next.hidden.length) return hidden;
  persist(next);
  return hidden;
}

/**
 * Mark a provider as configured-with-a-key: its models become hidden by
 * default. Idempotent; never overrides models the user explicitly showed.
 */
export function markProviderDefaultHidden(providerId: string): void {
  const current = getModelVisibility();
  if (current.defaultHiddenProviders.includes(providerId)) return;
  persist({ ...current, defaultHiddenProviders: [...current.defaultHiddenProviders, providerId] });
}

/** Subscribe to visibility changes; returns an unsubscribe function. */
export function subscribeModelVisibility(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: drop the in-memory cache so the next read re-reads storage. */
export function resetModelVisibilityCache(): void {
  cached = undefined;
}
