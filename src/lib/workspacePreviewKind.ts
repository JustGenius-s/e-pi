/**
 * Preview-kind routing for workspace files (core set: image / markdown /
 * pdf / text). Files outside these kinds open in the built-in editor when
 * they are editable text, or fall back to the OS when not.
 */

const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"]);
const MARKDOWN_EXTENSIONS = new Set(["md", "mdx"]);
const PDF_EXTENSIONS = new Set(["pdf"]);
const TEXT_EXTENSIONS = new Set(["log", "txt"]);

export type WorkspacePreviewKind = "image" | "markdown" | "pdf" | "text";

export function workspacePathExtension(path: string) {
  const normalized = path.trim().replace(/\\/g, "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  const extensionIndex = name.lastIndexOf(".");
  if (extensionIndex < 0) return "";
  return name.slice(extensionIndex + 1).toLowerCase();
}

export function getWorkspacePreviewKind(path: string): WorkspacePreviewKind | null {
  const extension = workspacePathExtension(path);
  if (!extension) return null;
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (PDF_EXTENSIONS.has(extension)) return "pdf";
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  return null;
}

export function isWorkspacePreviewPath(path: string) {
  return getWorkspacePreviewKind(path) !== null;
}

/** Text kinds that can switch from preview into the built-in editor. */
export function isWorkspaceEditablePreviewPath(path: string) {
  const extension = workspacePathExtension(path);
  return (
    extension === "md" ||
    extension === "mdx" ||
    extension === "html" ||
    extension === "htm" ||
    extension === "txt" ||
    extension === "log" ||
    extension === "csv" ||
    extension === "tsv"
  );
}
