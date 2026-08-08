import { afterEach, describe, expect, it } from "vitest";

import {
  clampCommandName,
  DEFAULT_QUICK_COMMANDS_SETTINGS,
  getQuickCommands,
  normalizeQuickCommands,
  QUICK_COMMANDS_MAX,
  QUICK_COMMANDS_STORAGE_KEY,
  QUICK_COMMAND_NAME_MAX,
  resetQuickCommandsCache,
  setQuickCommandsStorage,
  subscribeQuickCommands,
  updateQuickCommands,
} from "../src/lib/quickCommands";

const memory = new Map<string, string>();
const mockStorage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => {
    memory.set(key, value);
  },
};

afterEach(() => {
  memory.clear();
  resetQuickCommandsCache();
  setQuickCommandsStorage(undefined);
});

describe("quickCommands", () => {
  it("defaults to disabled with no commands", () => {
    setQuickCommandsStorage(mockStorage);
    expect(getQuickCommands()).toEqual(DEFAULT_QUICK_COMMANDS_SETTINGS);
    expect(getQuickCommands().enabled).toBe(false);
  });

  it("clamps display names to 10 characters", () => {
    expect(clampCommandName("12345678901")).toBe("1234567890");
    expect(clampCommandName("中文名字十个字").length).toBeLessThanOrEqual(QUICK_COMMAND_NAME_MAX);
    expect(
      normalizeQuickCommands({ commands: [{ id: "1", name: "a".repeat(20), prompt: "p" }] }).commands[0]?.name,
    ).toBe("a".repeat(10));
  });

  it("caps the command list at 5 and drops invalid entries", () => {
    const many = Array.from({ length: 7 }, (_, index) => ({
      id: String(index),
      name: `c${index}`,
      prompt: `p${index}`,
    }));
    const normalized = normalizeQuickCommands({ enabled: true, commands: many });
    expect(normalized.commands).toHaveLength(QUICK_COMMANDS_MAX);
    expect(normalized.commands[4]?.name).toBe("c4");

    const mixed = normalizeQuickCommands({
      enabled: true,
      commands: [
        { id: "ok", name: "Good", prompt: "prompt" },
        { id: 42, name: "Bad", prompt: "x" },
        null,
        { id: "no-name", prompt: "x" },
        { id: "no-prompt", name: "X" },
      ],
    });
    expect(mixed.commands).toHaveLength(1);
    expect(mixed.commands[0]).toEqual({ id: "ok", name: "Good", prompt: "prompt" });
  });

  it("coerces enabled to a boolean", () => {
    expect(normalizeQuickCommands({ enabled: "yes", commands: [] }).enabled).toBe(false);
    expect(normalizeQuickCommands({ enabled: true, commands: [] }).enabled).toBe(true);
  });

  it("persists updates to storage and notifies subscribers", () => {
    setQuickCommandsStorage(mockStorage);
    let notified = false;
    const listener = () => {
      notified = true;
    };
    subscribeQuickCommands(listener)();

    updateQuickCommands({
      enabled: true,
      commands: [{ id: "1", name: "Review", prompt: "Review the diff" }],
    });

    expect(notified).toBe(false); // unsubscribed immediately
    expect(getQuickCommands().enabled).toBe(true);

    subscribeQuickCommands(() => {
      notified = true;
    });
    updateQuickCommands({ enabled: false, commands: [] });
    expect(notified).toBe(true);

    const stored = JSON.parse(memory.get(QUICK_COMMANDS_STORAGE_KEY) ?? "null") as {
      enabled: boolean;
      commands: unknown[];
    };
    expect(stored.enabled).toBe(false);
  });

  it("re-reads storage after the cache is reset", () => {
    setQuickCommandsStorage(mockStorage);
    updateQuickCommands({ enabled: true, commands: [] });
    resetQuickCommandsCache();
    // Simulate another writer (e.g. a second window).
    memory.set(QUICK_COMMANDS_STORAGE_KEY, JSON.stringify({ enabled: false, commands: [] }));
    expect(getQuickCommands().enabled).toBe(false);
  });

  it("falls back to defaults on corrupted storage", () => {
    setQuickCommandsStorage(mockStorage);
    memory.set(QUICK_COMMANDS_STORAGE_KEY, "{not json");
    expect(getQuickCommands()).toEqual(DEFAULT_QUICK_COMMANDS_SETTINGS);
  });

  it("works without any storage available", () => {
    // No storage override and no window in the test env → in-memory only.
    updateQuickCommands({ enabled: true, commands: [{ id: "1", name: "X", prompt: "y" }] });
    expect(getQuickCommands().enabled).toBe(true);
  });
});
