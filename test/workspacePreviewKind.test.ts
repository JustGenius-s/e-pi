import { describe, expect, it } from "vitest";

import {
  getWorkspacePreviewKind,
  isWorkspaceEditablePreviewPath,
  isWorkspacePreviewPath,
  workspacePathExtension,
} from "../src/lib/workspacePreviewKind";

describe("workspacePreviewKind", () => {
  it("routes core preview kinds by extension", () => {
    expect(getWorkspacePreviewKind("a.png")).toBe("image");
    expect(getWorkspacePreviewKind("b/photo.JPG")).toBe("image");
    expect(getWorkspacePreviewKind("docs/readme.md")).toBe("markdown");
    expect(getWorkspacePreviewKind("docs/guide.mdx")).toBe("markdown");
    expect(getWorkspacePreviewKind("manual.pdf")).toBe("pdf");
    expect(getWorkspacePreviewKind("logs/app.log")).toBe("text");
    expect(getWorkspacePreviewKind("notes.txt")).toBe("text");
  });

  it("returns null for unknown and extensionless files", () => {
    expect(getWorkspacePreviewKind("main.ts")).toBeNull();
    expect(getWorkspacePreviewKind("Makefile")).toBeNull();
    expect(getWorkspacePreviewKind("noext")).toBeNull();
    expect(getWorkspacePreviewKind("dir/")).toBeNull();
  });

  it("handles windows-style separators", () => {
    expect(getWorkspacePreviewKind("C:\\docs\\readme.md")).toBe("markdown");
  });

  it("isWorkspacePreviewPath matches the router", () => {
    expect(isWorkspacePreviewPath("x.png")).toBe(true);
    expect(isWorkspacePreviewPath("x.ts")).toBe(false);
  });

  it("marks text kinds as editable in preview", () => {
    expect(isWorkspaceEditablePreviewPath("readme.md")).toBe(true);
    expect(isWorkspaceEditablePreviewPath("notes.txt")).toBe(true);
    expect(isWorkspaceEditablePreviewPath("data.csv")).toBe(true);
    expect(isWorkspaceEditablePreviewPath("photo.png")).toBe(false);
    expect(isWorkspaceEditablePreviewPath("main.ts")).toBe(false);
  });

  it("extracts extensions case-insensitively", () => {
    expect(workspacePathExtension("A.PNG")).toBe("png");
    expect(workspacePathExtension("noext")).toBe("");
    expect(workspacePathExtension(".hidden")).toBe("hidden");
  });
});
