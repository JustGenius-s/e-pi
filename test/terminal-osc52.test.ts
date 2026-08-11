import { describe, expect, it } from "vitest";

import { decodeOsc52Clipboard, MAX_OSC52_BASE64_LENGTH } from "../src/lib/terminalOsc52";

function encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("decodeOsc52Clipboard", () => {
  it("decodes Pi's clipboard target as UTF-8", () => {
    const text = "resize 后拖选复制\n中文与 emoji: 🚀";

    expect(decodeOsc52Clipboard(`c;${encode(text)}`)).toBe(text);
  });

  it("rejects other targets, queries, empty values, and malformed base64", () => {
    expect(decodeOsc52Clipboard(`p;${encode("text")}`)).toBeNull();
    expect(decodeOsc52Clipboard("c;?")).toBeNull();
    expect(decodeOsc52Clipboard("c;")).toBeNull();
    expect(decodeOsc52Clipboard("c;YWJjZA")).toBeNull();
    expect(decodeOsc52Clipboard("c;YWJj$A==")).toBeNull();
  });

  it("rejects invalid UTF-8 and oversized payloads", () => {
    expect(decodeOsc52Clipboard("c;/w==")).toBeNull();
    expect(decodeOsc52Clipboard(`c;${"A".repeat(MAX_OSC52_BASE64_LENGTH + 4)}`)).toBeNull();
  });
});
