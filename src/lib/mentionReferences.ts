/**
 * Code reference serialization for "add selection to chat".
 *
 * A reference carries only the path and line range — never the content —
 * serialized as a markdown link the pi agent can follow:
 *
 * [file.ts:10-20](src/file.ts#L10-L20)
 *
 * (Same contract as LiveAgent's mentionReferences; pi natively resolves
 * markdown links in user messages.)
 */

export type CodeMentionReference = {
  /** Workspace-relative posix path. */
  path: string;
  startLine: number;
  endLine: number;
};

/** Convert an absolute path to a workspace-relative posix path. */
export function toRelativeWorkspacePath(absPath: string, cwd: string): string {
  const normalizedAbs = absPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedCwd = (cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalizedCwd && normalizedAbs.startsWith(`${normalizedCwd}/`)) {
    return normalizedAbs.slice(normalizedCwd.length + 1);
  }
  return normalizedAbs;
}

function normalizeCodeMentionLine(value: number, fallback: number) {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

function validateRelativeMentionPath(path: string) {
  if (!path || path.startsWith("/") || path.startsWith("#")) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return false;
  return !path.split("/").some((part) => !part || part === "." || part === "..");
}

export function createCodeMentionReference(raw: {
  path: string;
  startLine: number;
  endLine: number;
}): CodeMentionReference | null {
  const path = raw.path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!validateRelativeMentionPath(path)) return null;
  const startLine = normalizeCodeMentionLine(raw.startLine, 1);
  const endLine = Math.max(startLine, normalizeCodeMentionLine(raw.endLine, startLine));
  return { path, startLine, endLine };
}

export function codeMentionLineLabel(reference: Pick<CodeMentionReference, "startLine" | "endLine">) {
  return reference.startLine === reference.endLine
    ? `${reference.startLine}`
    : `${reference.startLine}-${reference.endLine}`;
}

export function codeMentionDisplayName(reference: Pick<CodeMentionReference, "path">) {
  return reference.path.split("/").pop() || reference.path;
}

export function escapeMarkdownReferenceLabel(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/(\[|\])/g, "\\$1");
}

function codeMentionTokenLabel(reference: CodeMentionReference) {
  return `${codeMentionDisplayName(reference)}:${codeMentionLineLabel(reference)}`;
}

function formatMarkdownReferenceDestination(value: string) {
  const normalized = value.replace(/\\/g, "/");
  if (/[\s()<>[\]]/.test(normalized)) {
    return `<${normalized.replace(/</g, "%3C").replace(/>/g, "%3E")}>`;
  }
  return normalized;
}

function codeMentionTokenDestination(reference: CodeMentionReference) {
  const fragment =
    reference.startLine === reference.endLine
      ? `L${reference.startLine}`
      : `L${reference.startLine}-L${reference.endLine}`;
  return `${reference.path}#${fragment}`;
}

/**
 * Serialize a code reference as a markdown link the model can follow:
 * [file.ts:10-20](src/file.ts#L10-L20) — path and line range only, never the
 * referenced content itself.
 */
export function formatCodeMentionToken(raw: { path: string; startLine: number; endLine: number }, cwd: string): string {
  const relative = toRelativeWorkspacePath(raw.path, cwd);
  const reference = createCodeMentionReference({
    path: relative,
    startLine: raw.startLine,
    endLine: raw.endLine,
  });
  if (!reference) return raw.path;
  return `[${escapeMarkdownReferenceLabel(codeMentionTokenLabel(reference))}](${formatMarkdownReferenceDestination(codeMentionTokenDestination(reference))})`;
}

/**
 * A composer attachment reference (graphical chip in the input): a
 * workspace-relative path plus an optional line range. `startLine`/`endLine`
 * are undefined for whole-file references (file preview), set for code
 * selections (editor context menu). Serialized to the markdown-link format
 * below when the message is sent.
 */
export type ComposerReference = {
  /** Workspace-relative posix path. */
  path: string;
  startLine?: number;
  endLine?: number;
};

/** Stable identity for dedupe/keys: `path:start-end` (whole file = `path`). */
export function composerReferenceKey(reference: ComposerReference): string {
  const { path, startLine, endLine } = reference;
  if (startLine === undefined || endLine === undefined) return path;
  return `${path}:${startLine}-${endLine}`;
}

/** Serialize one reference to the agent-readable markdown link format. */
export function formatComposerReference(reference: ComposerReference, cwd: string): string {
  const { path, startLine, endLine } = reference;
  if (startLine === undefined || endLine === undefined) return formatFileMentionToken(path, cwd);
  return formatCodeMentionToken({ path, startLine, endLine }, cwd);
}

/** Serialize all references, space-separated, for the outgoing prompt. */
export function serializeComposerReferences(references: ComposerReference[], cwd: string): string {
  return references.map((reference) => formatComposerReference(reference, cwd)).join(" ");
}

/**
 * Serialize a whole-file reference (file preview "add to chat") as a
 * markdown link the model can follow: [name](path). No line range — the
 * preview has no selection.
 */
export function formatFileMentionToken(absPath: string, cwd: string): string {
  const relative = toRelativeWorkspacePath(absPath, cwd);
  const name = absPath.split(/[\\/]/).pop() || absPath;
  return `[${escapeMarkdownReferenceLabel(name)}](${formatMarkdownReferenceDestination(relative)})`;
}
