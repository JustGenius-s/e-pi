import { afterEach, describe, expect, it } from "vitest";

import {
  getModelVisibility,
  isModelHidden,
  markProviderDefaultHidden,
  MODEL_VISIBILITY_STORAGE_KEY,
  normalizeModelVisibility,
  resetModelVisibilityCache,
  setModelHidden,
  setModelVisibilityStorage,
  subscribeModelVisibility,
} from "../src/lib/modelVisibility";

const memory = new Map<string, string>();
const mockStorage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => {
    memory.set(key, value);
  },
};

afterEach(() => {
  memory.clear();
  resetModelVisibilityCache();
  setModelVisibilityStorage(undefined);
});

describe("modelVisibility", () => {
  it("starts with every model visible", () => {
    setModelVisibilityStorage(mockStorage);
    expect(isModelHidden("openai/gpt-5")).toBe(false);
    expect(isModelHidden("anthropic/claude")).toBe(false);
  });

  it("explicitly hiding and showing a model sticks", () => {
    setModelVisibilityStorage(mockStorage);
    setModelHidden("openai/gpt-5", true);
    expect(isModelHidden("openai/gpt-5")).toBe(true);
    setModelHidden("openai/gpt-5", false);
    expect(isModelHidden("openai/gpt-5")).toBe(false);
  });

  it("hides all models of a configured provider by default until shown", () => {
    setModelVisibilityStorage(mockStorage);
    markProviderDefaultHidden("openai");
    expect(isModelHidden("openai/gpt-5")).toBe(true);
    expect(isModelHidden("openai/gpt-5-mini")).toBe(true);
    // Other providers are unaffected.
    expect(isModelHidden("anthropic/claude")).toBe(false);
  });

  it("showing one model overrides the provider default; hiding it again wins", () => {
    setModelVisibilityStorage(mockStorage);
    markProviderDefaultHidden("openai");
    setModelHidden("openai/gpt-5", false);
    expect(isModelHidden("openai/gpt-5")).toBe(false);
    // A different model of the same provider stays hidden.
    expect(isModelHidden("openai/gpt-5-mini")).toBe(true);
    setModelHidden("openai/gpt-5", true);
    expect(isModelHidden("openai/gpt-5")).toBe(true);
  });

  it("marking a provider is idempotent and notifies subscribers once", () => {
    setModelVisibilityStorage(mockStorage);
    let notified = 0;
    subscribeModelVisibility(() => {
      notified += 1;
    });
    markProviderDefaultHidden("openai");
    markProviderDefaultHidden("openai");
    setModelHidden("a/b", true);
    setModelHidden("a/b", true); // no-op
    expect(notified).toBe(2);
  });

  it("normalizes stored state: only valid refs/strings survive", () => {
    expect(
      normalizeModelVisibility({
        shown: ["a/b", 42, null],
        hidden: ["c/d", "nope", ""],
        defaultHiddenProviders: ["openai", 7, ""],
      }),
    ).toEqual({ shown: ["a/b"], hidden: ["c/d"], defaultHiddenProviders: ["openai"] });
  });

  it("persists state and re-reads storage after the cache is reset", () => {
    setModelVisibilityStorage(mockStorage);
    markProviderDefaultHidden("openai");
    setModelHidden("openai/gpt-5", false);
    resetModelVisibilityCache();
    const stored = JSON.parse(memory.get(MODEL_VISIBILITY_STORAGE_KEY) ?? "null") as {
      shown: string[];
      hidden: string[];
      defaultHiddenProviders: string[];
    };
    expect(stored).toEqual({
      shown: ["openai/gpt-5"],
      hidden: [],
      defaultHiddenProviders: ["openai"],
    });
    expect(isModelHidden("openai/gpt-5")).toBe(false);
  });

  it("migrates the legacy model-hidden-v1 array into hidden", () => {
    setModelVisibilityStorage(mockStorage);
    memory.set("model-hidden-v1", JSON.stringify(["openai/gpt-5"]));
    expect(isModelHidden("openai/gpt-5")).toBe(true);
    expect(isModelHidden("openai/gpt-5-mini")).toBe(false);
  });

  it("falls back to all-visible on corrupted storage", () => {
    setModelVisibilityStorage(mockStorage);
    memory.set(MODEL_VISIBILITY_STORAGE_KEY, "{broken");
    expect(getModelVisibility()).toEqual({ shown: [], hidden: [], defaultHiddenProviders: [] });
  });

  it("works without any storage available", () => {
    setModelHidden("a/b", true);
    expect(isModelHidden("a/b")).toBe(true);
    markProviderDefaultHidden("openai");
    expect(isModelHidden("openai/x")).toBe(true);
  });
});
