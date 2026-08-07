import { describe, expect, it } from "vitest";

import {
  createCodeMentionReference,
  formatCodeMentionToken,
  toRelativeWorkspacePath,
} from "../src/lib/mentionReferences";

describe("mentionReferences", () => {
  describe("toRelativeWorkspacePath", () => {
    it("strips the cwd prefix", () => {
      expect(toRelativeWorkspacePath("/proj/e-pi/src/app.ts", "/proj/e-pi")).toBe("src/app.ts");
    });

    it("normalizes backslashes", () => {
      expect(toRelativeWorkspacePath("C:\\proj\\src\\app.ts", "C:\\proj")).toBe("src/app.ts");
    });

    it("keeps absolute paths outside the cwd", () => {
      expect(toRelativeWorkspacePath("/other/proj/app.ts", "/proj/e-pi")).toBe("/other/proj/app.ts");
    });
  });

  describe("createCodeMentionReference", () => {
    it("creates a reference with clamped line numbers", () => {
      const ref = createCodeMentionReference({ path: "src/app.ts", startLine: 10, endLine: 20 });
      expect(ref).toEqual({ path: "src/app.ts", startLine: 10, endLine: 20 });
    });

    it("normalizes endLine below startLine", () => {
      const ref = createCodeMentionReference({ path: "src/app.ts", startLine: 20, endLine: 5 });
      expect(ref?.endLine).toBe(20);
    });

    it("rejects absolute and traversal paths", () => {
      expect(createCodeMentionReference({ path: "/abs/path.ts", startLine: 1, endLine: 1 })).toBeNull();
      expect(createCodeMentionReference({ path: "../escape.ts", startLine: 1, endLine: 1 })).toBeNull();
      expect(createCodeMentionReference({ path: "https://x/y.ts", startLine: 1, endLine: 1 })).toBeNull();
    });

    it("rejects empty paths", () => {
      expect(createCodeMentionReference({ path: "", startLine: 1, endLine: 1 })).toBeNull();
    });
  });

  describe("formatCodeMentionToken", () => {
    it("formats a multi-line reference as a markdown link", () => {
      expect(formatCodeMentionToken({ path: "/proj/src/app.ts", startLine: 10, endLine: 20 }, "/proj")).toBe(
        "[app.ts:10-20](src/app.ts#L10-L20)",
      );
    });

    it("formats a single-line reference", () => {
      expect(formatCodeMentionToken({ path: "/proj/src/app.ts", startLine: 7, endLine: 7 }, "/proj")).toBe(
        "[app.ts:7](src/app.ts#L7)",
      );
    });

    it("escapes markdown special characters in the label", () => {
      expect(formatCodeMentionToken({ path: "/proj/a[b].ts", startLine: 1, endLine: 1 }, "/proj")).toBe(
        "[a\\[b\\].ts:1](<a[b].ts#L1>)",
      );
    });
  });
});
