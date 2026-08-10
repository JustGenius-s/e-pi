import { appendTerminalBuffer } from "./terminalReplayStore";

let feederStarted = false;

/**
 * Buffer every session's output for the lifetime of the renderer process.
 * Keeping this subscription outside either terminal implementation prevents
 * mode switches from registering duplicate global listeners.
 */
export function ensureTerminalBufferFeeder(): void {
  if (feederStarted) return;
  feederStarted = true;
  window.ePi.runtime.onAnyData((sessionPath, data) => appendTerminalBuffer(sessionPath, data));
}
