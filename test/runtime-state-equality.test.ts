import { describe, expect, it } from "vitest";

import { isSameRuntimeState } from "../src/lib/runtimeStateEquality";
import type { PiRuntimeState } from "../src/types/contracts";

function baseState(): PiRuntimeState {
  return {
    status: "running",
    sessionPath: "/sessions/foo",
    cwd: "/work",
    generation: 3,
    activity: "busy",
    waitingUser: { kind: "permission", detail: "allow bash" },
    model: { provider: "openai", id: "gpt-5" },
    thinkingLevel: "high",
    supportedThinkingLevels: ["low", "medium", "high"],
    context: { tokens: 1200, contextWindow: 100_000, percent: 1.2 },
    usage: { input: 100, output: 50, cacheRead: 30, cacheWrite: 10, cost: 0.0042 },
    cacheHitRate: 62,
    speed: 41.5,
    pid: 4242,
    exitCode: undefined,
    signal: undefined,
    error: undefined,
  };
}

describe("isSameRuntimeState", () => {
  it("returns true for structurally identical states", () => {
    expect(isSameRuntimeState(baseState(), baseState())).toBe(true);
    expect(isSameRuntimeState(baseState(), { ...baseState() })).toBe(true);
  });

  it("detects a change in every scalar field", () => {
    const state = baseState();
    const cases: Array<[keyof PiRuntimeState, unknown]> = [
      ["status", "idle"],
      ["sessionPath", "/sessions/other"],
      ["cwd", "/elsewhere"],
      ["generation", 4],
      ["activity", "idle"],
      ["thinkingLevel", "medium"],
      ["cacheHitRate", 0],
      ["speed", 0],
      ["pid", 1],
      ["exitCode", 0],
      ["signal", 9],
      ["error", "boom"],
    ];
    for (const [key, value] of cases) {
      const modified = { ...state, [key]: value } as PiRuntimeState;
      expect(isSameRuntimeState(state, modified), `field ${String(key)} changed`).toBe(false);
      expect(isSameRuntimeState(modified, state), `field ${String(key)} changed (reversed)`).toBe(false);
    }
  });

  it("detects changes inside nested objects and arrays", () => {
    const state = baseState();
    const nested: Array<[string, PiRuntimeState]> = [
      ["waitingUser.kind", { ...state, waitingUser: { ...state.waitingUser!, kind: "ask_user" } }],
      ["waitingUser.detail", { ...state, waitingUser: { ...state.waitingUser!, detail: undefined } }],
      ["model.provider", { ...state, model: { ...state.model!, provider: "anthropic" } }],
      ["model.id", { ...state, model: { ...state.model!, id: "claude" } }],
      ["context.tokens", { ...state, context: { ...state.context!, tokens: null } }],
      ["context.contextWindow", { ...state, context: { ...state.context!, contextWindow: 200_000 } }],
      ["context.percent", { ...state, context: { ...state.context!, percent: null } }],
      ["usage.input", { ...state, usage: { ...state.usage!, input: 101 } }],
      ["usage.output", { ...state, usage: { ...state.usage!, output: 51 } }],
      ["usage.cacheRead", { ...state, usage: { ...state.usage!, cacheRead: 31 } }],
      ["usage.cacheWrite", { ...state, usage: { ...state.usage!, cacheWrite: 11 } }],
      ["usage.cost", { ...state, usage: { ...state.usage!, cost: 0.1 } }],
      ["supportedThinkingLevels order", { ...state, supportedThinkingLevels: ["high", "low", "medium"] }],
      [
        "supportedThinkingLevels length",
        { ...state, supportedThinkingLevels: [...state.supportedThinkingLevels!, "max"] },
      ],
    ];
    for (const [label, modified] of nested) {
      expect(isSameRuntimeState(state, modified), `${label} changed`).toBe(false);
    }
  });

  it("treats undefined and null as different for nullable fields", () => {
    const state = baseState();
    expect(isSameRuntimeState(state, { ...state, waitingUser: null })).toBe(false);
    expect(isSameRuntimeState({ ...state, waitingUser: undefined }, { ...state, waitingUser: null })).toBe(false);
    expect(isSameRuntimeState({ ...state, waitingUser: undefined }, { ...state, waitingUser: undefined })).toBe(true);
    expect(isSameRuntimeState({ ...state, waitingUser: null }, { ...state, waitingUser: null })).toBe(true);
    // model: undefined vs absent vs present
    expect(isSameRuntimeState({ ...state, model: undefined }, { ...state, model: undefined })).toBe(true);
    expect(isSameRuntimeState({ ...state, model: undefined }, state)).toBe(false);
  });

  it("handles absent optional fields consistently", () => {
    const minimal: PiRuntimeState = { status: "starting", sessionPath: "/s", generation: 0 };
    expect(isSameRuntimeState(minimal, { ...minimal })).toBe(true);
    expect(isSameRuntimeState(minimal, { ...minimal, activity: "idle" })).toBe(false);
  });
});
