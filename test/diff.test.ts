import { describe, expect, it } from "vitest";

import { parseDiff } from "../src/lib/diff";

const SAMPLE_DIFF = `diff --git a/src/App.tsx b/src/App.tsx
index 1234567..89abcde 100644
--- a/src/App.tsx
+++ b/src/App.tsx
@@ -12,4 +12,6 @@ import { useState } from "react";
 const title = "hello";
-const count = 1;
-const label = "world";
+const count = 2;
+const label = "pi";
+const extra = true;
 return <div>{count}</div>;
`;

describe("parseDiff", () => {
  it("parses hunks, line numbers, and change counts", () => {
    const parsed = parseDiff(SAMPLE_DIFF);
    expect(parsed.binary).toBe(false);
    expect(parsed.truncated).toBe(false);
    expect(parsed.additions).toBe(3);
    expect(parsed.deletions).toBe(2);
    expect(parsed.hunks).toHaveLength(1);

    const hunk = parsed.hunks[0]!;
    expect(hunk.oldStart).toBe(12);
    expect(hunk.oldCount).toBe(4);
    expect(hunk.newStart).toBe(12);
    expect(hunk.newCount).toBe(6);
    expect(hunk.heading).toBe(' import { useState } from "react";');
    expect(hunk.lines.map((l) => l.type)).toEqual(["context", "del", "del", "add", "add", "add", "context"]);
  });

  it("tracks old/new line numbers per side", () => {
    const parsed = parseDiff(SAMPLE_DIFF);
    const lines = parsed.hunks[0]!.lines;
    expect(lines[0]!.oldNo).toBe(12);
    expect(lines[0]!.newNo).toBe(12);
    expect(lines[1]!.oldNo).toBe(13);
    expect(lines[1]!.newNo).toBeNull();
    expect(lines[3]!.oldNo).toBeNull();
    expect(lines[3]!.newNo).toBe(13);
    expect(lines[5]!.newNo).toBe(15);
  });

  it("highlights changed words on paired del/add lines", () => {
    const parsed = parseDiff(SAMPLE_DIFF);
    const lines = parsed.hunks[0]!.lines;
    // "const count = 1;" vs "const count = 2;" → only the trailing token differs.
    expect(lines[1]!.highlights).toEqual([[14, 16]]);
    expect(lines[3]!.highlights).toEqual([[14, 16]]);
    // "const label = \"world\";" vs "const label = \"pi\";" → quoted word + semicolon.
    expect(lines[2]!.highlights).toEqual([[14, 22]]);
    expect(lines[4]!.highlights).toEqual([[14, 19]]);
  });

  it("detects binary diffs", () => {
    const parsed = parseDiff("Binary files a/logo.png and b/logo.png differ\n");
    expect(parsed.binary).toBe(true);
    expect(parsed.hunks).toHaveLength(0);
  });

  it("handles untracked-file diffs (new file from /dev/null)", () => {
    const parsed = parseDiff(
      "diff --git a/dev/null b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+first\n+second\n",
    );
    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.hunks[0]!.oldStart).toBe(0);
    expect(parsed.additions).toBe(2);
    const first = parsed.hunks[0]!.lines[0]!;
    expect(first.type).toBe("add");
    expect(first.oldNo).toBeNull();
    expect(first.newNo).toBe(1);
  });

  it("flags truncated diffs and keeps counting", () => {
    const parsed = parseDiff("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n[diff truncated]\n");
    expect(parsed.truncated).toBe(true);
    expect(parsed.additions).toBe(1);
    expect(parsed.deletions).toBe(1);
  });

  it("attaches no-newline markers to the preceding line", () => {
    const parsed = parseDiff(
      "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n same\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
    );
    const lines = parsed.hunks[0]!.lines;
    expect(lines[1]!.noNewline).toBe(true);
    expect(lines[2]!.noNewline).toBe(true);
    expect(lines[0]!.noNewline).toBe(false);
  });

  it("returns an empty result for non-diff text", () => {
    const parsed = parseDiff("");
    expect(parsed.hunks).toHaveLength(0);
    expect(parsed.binary).toBe(false);
    expect(parsed.additions).toBe(0);
    expect(parsed.deletions).toBe(0);
  });

  it("bails out of word diff on huge lines", () => {
    const long = "word ".repeat(600);
    const parsed = parseDiff(`--- a/x\n+++ b/x\n@@ -1 +1 @@\n-${long}\n+${long}x\n`);
    const lines = parsed.hunks[0]!.lines;
    expect(lines[0]!.highlights).toEqual([]);
    expect(lines[1]!.highlights).toEqual([]);
  });
});
