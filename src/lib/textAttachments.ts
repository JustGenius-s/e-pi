/**
 * Text attachments: pasting a large chunk of text into the composer doesn't
 * dump it all into the input box — instead it becomes a graphical chip above
 * the input carrying a summary (title, line count, size), and the full text
 * is serialized into the outgoing message.
 */

/** Pastes at or above this many characters become attachments. */
export const TEXT_ATTACHMENT_THRESHOLD_CHARS = 500;

/** Attachment title preview length. */
const TITLE_MAX_CHARS = 40;

export interface ComposerTextAttachment {
  id: string;
  /** Full text, sent verbatim. */
  text: string;
  /** First-line preview for the chip label. */
  title: string;
  lineCount: number;
  charCount: number;
}

/** Should this pasted text become an attachment chip instead of entering the input? */
export function shouldAttachAsTextAttachment(text: string): boolean {
  return text.length >= TEXT_ATTACHMENT_THRESHOLD_CHARS;
}

/** Compact byte-ish size label: 1.2K, 34K, 1.1M. */
export function formatAttachmentSize(chars: number): string {
  if (chars < 1_000) return `${chars}`;
  if (chars < 10_000) return `${(chars / 1_000).toFixed(1)}K`;
  if (chars < 1_000_000) return `${Math.round(chars / 1_000)}K`;
  return `${(chars / 1_000_000).toFixed(1)}M`;
}

/** Build an attachment from pasted text (trimmed of leading/trailing blank lines). */
export function createTextAttachment(text: string): ComposerTextAttachment {
  const trimmed = text.replace(/^\n+|\n+$/g, "");
  const firstLine = trimmed.split("\n")[0] ?? "";
  const title =
    firstLine.trim().length > TITLE_MAX_CHARS
      ? `${firstLine.trim().slice(0, TITLE_MAX_CHARS - 1)}…`
      : firstLine.trim() || "(empty)";
  return {
    id: crypto.randomUUID(),
    text: trimmed,
    title,
    lineCount: trimmed.split("\n").length,
    charCount: trimmed.length,
  };
}

/** Serialize text attachments for the outgoing prompt. */
export function serializeTextAttachments(attachments: ComposerTextAttachment[]): string {
  return attachments
    .map((attachment) => `Attached text "${attachment.title}" (${attachment.lineCount} lines):\n${attachment.text}`)
    .join("\n\n");
}
