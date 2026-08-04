import { describe, expect, it } from "vitest";
import { compactPath, pathBaseName, sessionTitle, statusLabel, statusTone } from "../src/lib/format";
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

  it("preserves short paths and compacts long paths", () => {
    expect(compactPath("/tmp/pi")).toBe("/tmp/pi");
    expect(compactPath("/Users/developer/Projects/a/very/long/path/e-pi", 32)).toBe(
      "/Users/.../path/e-pi",
    );
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
