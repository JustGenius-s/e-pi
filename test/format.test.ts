import { describe, expect, it } from "vitest";

import {
  compactPath,
  pathBaseName,
  SESSION_NAME_MAX_LENGTH,
  sessionRenameDraft,
  sessionTitle,
  statusLabel,
  statusTone,
  truncateText,
} from "../src/lib/format";
import type { SessionSummary } from "../src/types/contracts";

const session: SessionSummary = {
  path: "/tmp/session.jsonl",
  id: "session-1",
  cwd: "/Users/developer/Code/e-pi",
  createdAt: "2026-08-04T00:00:00.000Z",
  modifiedAt: "2026-08-04T00:00:00.000Z",
  messageCount: 1,
  firstMessage: "Inspect this repository",
  searchText: "Inspect this repository",
};

describe("format helpers", () => {
  it("prefers an explicit session name", () => {
    expect(sessionTitle({ ...session, name: "Package manager" })).toBe("Package manager");
    expect(sessionTitle(session)).toBe("Inspect this repository");
  });

  it("truncates huge first messages in display titles", () => {
    const wall = "A".repeat(200);
    expect(sessionTitle({ ...session, firstMessage: wall })).toBe(`${"A".repeat(80)}…`);
    expect(truncateText("  hello   world  ", 20)).toBe("hello world");
  });

  it("drafts a bounded rename value from a huge first message", () => {
    const wall = `skill docs\n${"x".repeat(500)}`;
    const draft = sessionRenameDraft({ ...session, name: undefined, firstMessage: wall });
    expect(draft).toBe("skill docs xxxxxxxxx");
    expect(draft.length).toBe(SESSION_NAME_MAX_LENGTH);
    expect(draft.includes("\n")).toBe(false);
    expect(sessionRenameDraft({ ...session, name: "My chat" })).toBe("My chat");
    expect(sessionRenameDraft({ ...session, name: "n".repeat(40) })).toBe("n".repeat(SESSION_NAME_MAX_LENGTH));
  });

  it("preserves short paths and compacts long paths", () => {
    expect(compactPath("/tmp/pi")).toBe("/tmp/pi");
    expect(compactPath("/Users/developer/Projects/a/very/long/path/e-pi", 32)).toBe("/Users/.../path/e-pi");
  });

  it("extracts the last path segment", () => {
    expect(pathBaseName("/Users/developer/Code/e-pi")).toBe("e-pi");
    expect(pathBaseName("/tmp/pi")).toBe("pi");
    expect(pathBaseName("/")).toBe("/");
  });

  it("maps runtime state to a semantic label and tone", () => {
    expect(statusLabel("running")).toBe("Session active");
    expect(statusTone("running")).toBe("live");
    expect(statusTone("error")).toBe("danger");
  });
});
