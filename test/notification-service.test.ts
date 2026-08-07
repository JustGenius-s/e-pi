import { beforeEach, describe, expect, it, vi } from "vitest";

/** Captured Notification instances created by the service under test. */
const mocks = vi.hoisted(() => {
  const shown: Array<{ title: string; body: string }> = [];
  const isSupported = vi.fn(() => true);
  class FakeNotification {
    static isSupported = isSupported;
    title: string;
    body: string;
    constructor(options: { title: string; body: string }) {
      this.title = options.title;
      this.body = options.body;
      shown.push(options);
    }
    on(_event: string, _handler: () => void): void {}
    show(): void {}
  }
  return { shown, isSupported, FakeNotification };
});

vi.mock("electron", () => ({
  Notification: mocks.FakeNotification,
}));

// The service resolves the session title through the pi agent SDK; stub it so
// tests don't load the real package.
vi.mock("../electron/main/services/pi-agent-loader", () => ({
  loadPiAgent: vi.fn(async () => {
    throw new Error("unavailable");
  }),
}));

import { TaskNotificationService } from "../electron/main/services/notification-service";
import type { PiRuntimeState } from "../src/types/contracts";

function state(partial: Partial<PiRuntimeState>): PiRuntimeState {
  return {
    status: "running",
    sessionPath: "/sessions/abc.jsonl",
    cwd: "/work",
    generation: 1,
    ...partial,
  };
}

const options = { activeSessionPath: undefined, windowFocused: false };

/** Let the async notify() promise settle. */
async function flush(): Promise<void> {
  await vi.waitFor(() => {
    expect(mocks.shown.length).toBeGreaterThanOrEqual(1);
  });
}

describe("TaskNotificationService", () => {
  beforeEach(() => {
    mocks.shown.length = 0;
  });

  it("shows a Task completed banner on busy -> idle for a background session", async () => {
    const service = new TaskNotificationService(
      () => undefined,
      () => undefined,
    );
    service.observe(state({ activity: "busy" }), options);
    expect(service.observe(state({ activity: "idle" }), options)).toBe(true);
    await flush();
    expect(mocks.shown[0]).toMatchObject({ body: "Task completed" });
  });

  it("skips the Task completed banner when the session is visible", () => {
    const service = new TaskNotificationService(
      () => undefined,
      () => undefined,
    );
    service.observe(state({ activity: "busy" }), options);
    const visible = { activeSessionPath: "/sessions/abc.jsonl", windowFocused: true };
    expect(service.observe(state({ activity: "idle" }), visible)).toBe(false);
    expect(mocks.shown).toHaveLength(0);
  });

  it("shows a Needs your approval banner when a permission prompt appears", async () => {
    const service = new TaskNotificationService(
      () => undefined,
      () => undefined,
    );
    service.observe(state({ activity: "busy" }), options);
    const notified = service.observe(
      state({ activity: "busy", waitingUser: { kind: "permission", detail: "git push --force" } }),
      options,
    );
    expect(notified).toBe(true);
    await flush();
    expect(mocks.shown[0].body).toContain("Needs your approval");
    expect(mocks.shown[0].body).toContain("git push --force");
  });

  it("shows an Asks you a question banner when an ask_user question appears", async () => {
    const service = new TaskNotificationService(
      () => undefined,
      () => undefined,
    );
    service.observe(state({ activity: "busy" }), options);
    const notified = service.observe(
      state({ activity: "busy", waitingUser: { kind: "ask_user", detail: "Which approach?" } }),
      options,
    );
    expect(notified).toBe(true);
    await flush();
    expect(mocks.shown[0].body).toContain("Asks you a question");
    expect(mocks.shown[0].body).toContain("Which approach?");
  });

  it("does not fire again while the same wait is still pending", async () => {
    const service = new TaskNotificationService(
      () => undefined,
      () => undefined,
    );
    service.observe(state({ activity: "busy" }), options);
    service.observe(state({ activity: "busy", waitingUser: { kind: "permission", detail: "rm -rf x" } }), options);
    expect(
      service.observe(state({ activity: "busy", waitingUser: { kind: "permission", detail: "rm -rf x" } }), options),
    ).toBe(false);
    await flush();
    expect(mocks.shown).toHaveLength(1);
  });

  it("fires again when a new wait starts after the previous one cleared", () => {
    const service = new TaskNotificationService(
      () => undefined,
      () => undefined,
    );
    service.observe(state({ activity: "busy" }), options);
    service.observe(state({ activity: "busy", waitingUser: { kind: "permission", detail: "git push" } }), options);
    service.observe(state({ activity: "busy", waitingUser: null }), options);
    expect(
      service.observe(state({ activity: "busy", waitingUser: { kind: "permission", detail: "npm install" } }), options),
    ).toBe(true);
  });

  it("does not treat a wait as task completion", async () => {
    const service = new TaskNotificationService(
      () => undefined,
      () => undefined,
    );
    service.observe(state({ activity: "busy" }), options);
    // Waiting for input must not raise a "Task completed" banner.
    service.observe(state({ activity: "busy", waitingUser: { kind: "ask_user" } }), options);
    await flush();
    expect(mocks.shown[0].body).not.toContain("Task completed");
  });

  it("skips the waiting banner when the session is visible", () => {
    const service = new TaskNotificationService(
      () => undefined,
      () => undefined,
    );
    const visible = { activeSessionPath: "/sessions/abc.jsonl", windowFocused: true };
    expect(service.observe(state({ activity: "busy", waitingUser: { kind: "permission" } }), visible)).toBe(false);
    expect(mocks.shown).toHaveLength(0);
  });

  it("stays silent when notifications are unsupported", async () => {
    mocks.isSupported.mockReturnValue(false);
    try {
      const service = new TaskNotificationService(
        () => undefined,
        () => undefined,
      );
      service.observe(state({ activity: "busy" }), options);
      service.observe(state({ activity: "idle" }), options);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(mocks.shown).toHaveLength(0);
    } finally {
      mocks.isSupported.mockReturnValue(true);
    }
  });
});
