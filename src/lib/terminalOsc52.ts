const OSC52_CLIPBOARD_PREFIX = "c;";
const BASE64_PAYLOAD_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Bound terminal-controlled clipboard writes before allocating decoded bytes.
 * This permits roughly 750 KB of UTF-8 text, comfortably above Pi's normal
 * selection and `/copy` payloads without accepting an unbounded OSC string.
 */
export const MAX_OSC52_BASE64_LENGTH = 1_000_000;

/** Decode the `c;<base64>` payload emitted by Pi's fullscreen text selection. */
export function decodeOsc52Clipboard(data: string): string | null {
  if (!data.startsWith(OSC52_CLIPBOARD_PREFIX)) return null;

  const encoded = data.slice(OSC52_CLIPBOARD_PREFIX.length);
  if (!encoded || encoded.length > MAX_OSC52_BASE64_LENGTH || !BASE64_PAYLOAD_PATTERN.test(encoded)) {
    return null;
  }

  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
