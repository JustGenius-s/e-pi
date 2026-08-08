import { describe, expect, it } from "vitest";

import { emitInsertComposerReference, onInsertComposerReference } from "../src/lib/composerBus";

describe("composerBus", () => {
  it("reports handled when at least one listener accepts the reference", () => {
    const unsubscribe = onInsertComposerReference(() => true);
    expect(emitInsertComposerReference({ path: "src/app.ts", startLine: 1, endLine: 2 })).toBe(true);
    unsubscribe();
  });

  it("reports unhandled when no listener accepts the reference", () => {
    const unsubscribe = onInsertComposerReference(() => false);
    expect(emitInsertComposerReference({ path: "src/app.ts" })).toBe(false);
    unsubscribe();
    expect(emitInsertComposerReference({ path: "src/app.ts" })).toBe(false);
  });

  it("delivers the reference to every subscriber and stops when unsubscribed", () => {
    const received: string[] = [];
    const unsubscribe = onInsertComposerReference((reference) => {
      received.push(reference.path);
      return true;
    });
    emitInsertComposerReference({ path: "a.ts", startLine: 3, endLine: 3 });
    unsubscribe();
    emitInsertComposerReference({ path: "b.ts" });
    expect(received).toEqual(["a.ts"]);
  });
});
