import { basename } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Notification } from "electron";

import type { PiRuntimeState } from "../../../src/types/contracts";

/** Session titles are free text; keep the banner body short. */
const MAX_TITLE_LENGTH = 60;

function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Tracks each session's last reported activity so a busy -> idle transition
 * (a task finishing) can raise a native notification. Notifications are only
 * sent for sessions that finished in the background: while the window is
 * focused on that session the terminal is already visible, so a banner would
 * just be noise.
 */
export class TaskNotificationService {
  #lastActivity = new Map<string, "busy" | "idle">();

  /** Called when the user clicks the banner (default: focus the window). */
  readonly #onActivate: (sessionPath: string) => void;

  /** Called when the OS refuses to show a banner (e.g. permission denied). */
  readonly #onPermissionError: () => void;

  /**
   * Keep live Notification instances referenced: on some platforms the
   * banner disappears (or never shows) once the instance is garbage
   * collected, so hold it until it closes/errors.
   */
  readonly #active = new Set<Notification>();

  constructor(onActivate: (sessionPath: string) => void, onPermissionError: () => void) {
    this.#onActivate = onActivate;
    this.#onPermissionError = onPermissionError;
  }

  /**
   * Feed every runtime state update. Returns true when a notification was
   * shown for this update.
   */
  observe(
    state: PiRuntimeState,
    options: { activeSessionPath: string | undefined; windowFocused: boolean },
  ): boolean {
    if (state.activity !== "busy" && state.activity !== "idle") return false;
    const previous = this.#lastActivity.get(state.sessionPath);
    this.#lastActivity.set(state.sessionPath, state.activity);
    if (previous !== "busy" || state.activity !== "idle") return false;
    // Task finished. Skip when the user is already looking at this session.
    if (options.activeSessionPath === state.sessionPath && options.windowFocused) return false;
    void this.notify(state);
    return true;
  }

  /** Show the native banner. The first call triggers the OS permission prompt. */
  async notify(state: PiRuntimeState): Promise<boolean> {
    if (!Notification.isSupported()) return false;
    try {
      // Prefer the session title (renamed name, else first message), then
      // fall back to the cwd folder name.
      let label = state.cwd ? basename(state.cwd) : "Pi";
      try {
        const sessions = await SessionManager.listAll();
        const session = sessions.find((candidate) => candidate.path === state.sessionPath);
        if (session) {
          const title = normalizeTitle(session.name ?? session.firstMessage ?? "");
          if (title) label = title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH)}…` : title;
        }
      } catch {
        // Session index unavailable — keep the cwd label.
      }
      const notification = new Notification({
        title: label,
        body: "Task completed",
      });
      notification.on("click", () => this.#onActivate(state.sessionPath));
      const release = () => {
        this.#active.delete(notification);
      };
      notification.on("close", release);
      notification.on("failed", (_event, error) => {
        release();
        // macOS UNErrorDomain 1 = notifications not allowed. The OS only asks
        // once and never re-prompts, so point the user at the settings pane.
        if (error.includes("UNErrorDomain")) this.#onPermissionError();
      });
      this.#active.add(notification);
      notification.show();
      return true;
    } catch {
      // Permission denied or notifications unavailable — stay silent.
      return false;
    }
  }
}
