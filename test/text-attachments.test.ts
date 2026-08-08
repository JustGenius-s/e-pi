import { describe, expect, it } from "vitest";

import {
  createTextAttachment,
  formatAttachmentSize,
  serializeTextAttachments,
  shouldAttachAsTextAttachment,
  TEXT_ATTACHMENT_THRESHOLD_CHARS,
} from "../src/lib/textAttachments";

describe("textAttachments", () => {
  it("turns pastes at or above the threshold into attachments", () => {
    const small = "x".repeat(TEXT_ATTACHMENT_THRESHOLD_CHARS - 1);
    const large = "x".repeat(TEXT_ATTACHMENT_THRESHOLD_CHARS);
    expect(shouldAttachAsTextAttachment(small)).toBe(false);
    expect(shouldAttachAsTextAttachment(large)).toBe(true);
    expect(shouldAttachAsTextAttachment("")).toBe(false);
  });

  it("summarizes title, line count and char count, trimming blank edges", () => {
    const attachment = createTextAttachment("\n\nline one\nline two\nline three\n\n");
    expect(attachment.title).toBe("line one");
    expect(attachment.lineCount).toBe(3);
    expect(attachment.charCount).toBe("line one\nline two\nline three".length);
    expect(attachment.text.endsWith("line three")).toBe(true);
  });

  it("truncates long first lines in the title with an ellipsis", () => {
    const longLine = "a".repeat(80);
    const attachment = createTextAttachment(longLine);
    expect(attachment.title.endsWith("…")).toBe(true);
    expect(attachment.title.length).toBeLessThan(60);
  });

  it("labels empty text as (empty)", () => {
    expect(createTextAttachment("\n").title).toBe("(empty)");
  });

  it("formats compact sizes", () => {
    expect(formatAttachmentSize(900)).toBe("900");
    expect(formatAttachmentSize(1_234)).toBe("1.2K");
    expect(formatAttachmentSize(34_000)).toBe("34K");
    expect(formatAttachmentSize(1_100_000)).toBe("1.1M");
  });

  it("serializes attachments with their title and line count", () => {
    const one = createTextAttachment("first line\nsecond line");
    const two = createTextAttachment("other text");
    const serialized = serializeTextAttachments([one, two]);
    expect(serialized).toContain('Attached text "first line" (2 lines):\nfirst line\nsecond line');
    expect(serialized).toContain('Attached text "other text" (1 lines):\nother text');
  });
});
