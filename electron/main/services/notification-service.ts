import { basename } from "node:path";

import { Notification } from "electron";

import type { PiRuntimeState, WaitingUserState } from "../../../src/types/contracts";
import { loadPiAgent } from "./pi-agent-loader";

/** Session titles are free text; keep the banner body short. */
const MAX_TITLE_LENGTH = 60;
/** Notification detail lines (permission value / question) are truncated too. */
const MAX_DETAIL_LENGTH = 90;

function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Tracks each session's last reported activity so a busy -> idle transition
 * (a task finishing) can raise a native notification, and each session's
 * waiting-on-human state so entering a permission prompt or ask_user question
 * raises a "needs input" banner. Notifications are only sent for sessions that
 * finished in the background: while the window is focused on that session the
 * terminal is already visible, so a banner would just be noise.
 *
 * Waiting-for-input is NOT task completion: the agent turn stays busy and
 * resumes once the user interacts, so it is reported as its own event type
 * ("needs your approval" / "asks you a question").
 */
export class TaskNotificationService {
  #lastActivity = new Map<string, "busy" | "idle">();
  /** Last waiting state per session; undefined while the session is not blocked. */
  #lastWait = new Map<string, WaitingUserState | undefined>();

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
  observe(state: PiRuntimeState, options: { activeSessionPath: string | undefined; windowFocused: boolean }): boolean {
    let notified = false;
    // The user is already looking at this session: no banner needed.
    const visible = options.activeSessionPath === state.sessionPath && options.windowFocused;

    // Task finished: busy -> idle on a background session.
    if (state.activity === "busy" || state.activity === "idle") {
      const previous = this.#lastActivity.get(state.sessionPath);
      this.#lastActivity.set(state.sessionPath, state.activity);
      if (previous === "busy" && state.activity === "idle" && !visible) {
        void this.notify(state, "Task completed");
        notified = true;
      }
    }

    // Waiting on the human: a permission approval prompt or an ask_user
    // question appeared. Not a task-completion event — the session resumes
    // once the user interacts.
    const waiting = state.waitingUser ?? undefined;
    const previousWait = this.#lastWait.get(state.sessionPath);
    this.#lastWait.set(state.sessionPath, waiting);
    const enteredWait = waiting !== undefined && (previousWait === undefined || previousWait.kind !== waiting.kind);
    if (enteredWait && !visible) {
      void this.notify(state, waiting.kind === "permission" ? "Needs your approval" : "Asks you a question", {
        detail: waiting.detail,
      });
      notified = true;
    }
    return notified;
  }

  /** Show the native banner. The first call triggers the OS permission prompt. */
  async notify(state: PiRuntimeState, body: string, options: { detail?: string } = {}): Promise<boolean> {
    if (!Notification.isSupported()) return false;
    try {
      // Prefer the session title (renamed name, else first message), then
      // fall back to the cwd folder name.
      let label = state.cwd ? basename(state.cwd) : "Pi";
      try {
        const { SessionManager } = await loadPiAgent();
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
        body: options.detail
          ? `${body}: ${options.detail.length > MAX_DETAIL_LENGTH ? `${options.detail.slice(0, MAX_DETAIL_LENGTH)}…` : options.detail}`
          : body,
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
