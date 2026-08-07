import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

/** Thinking levels pi exposes (mirrors pi's own ThinkingLevel union). */
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Full ordered set of thinking levels pi knows about. */
const EXTENDED_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Levels a model actually supports, mirroring pi-ai's getSupportedThinkingLevels
 * (thinkingLevelMap null holes hide levels; xhigh/max require an explicit entry).
 */
function supportedThinkingLevelsOf(
  model: { reasoning?: boolean; thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>> } | undefined,
): ThinkingLevel[] | undefined {
  if (!model) return undefined;
  if (!model.reasoning) return ["off"];
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

const ACTIVITY_SUFFIX = ".e-pi-activity.json";

/** Minimal shape of pi's per-response Usage (pi-ai) that we consume. */
interface ProviderUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: { total?: number };
}

/**
 * Per-session activity reporting. Writes a tiny JSON sidecar next to the
 * session file so the Electron main process can show "working vs idle" for
 * sessions that run in the background. `SessionManager.listAll` only picks up
 * `.jsonl` files, so the sidecar never appears as a session.
 */
interface BridgeContext {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

interface BridgeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** Why a session is blocked waiting for the human (mirrors WaitingUserState). */
interface BridgeWaitingUser {
  kind: "permission" | "ask_user";
  /** Short display text for the notification (permission value or the question). */
  detail?: string;
}

interface BridgeState {
  status: "busy" | "idle";
  model?: { provider: string; id: string };
  /** Current thinking level in this pi process (after model clamping). */
  thinkingLevel?: ThinkingLevel;
  /** Thinking levels the current model supports (drives the composer menu). */
  supportedThinkingLevels?: ThinkingLevel[];
  context?: BridgeContext;
  usage?: BridgeUsage;
  /** Cache hit rate (0-100) of the latest assistant response. */
  cacheHitRate?: number;
  /** Output speed of the latest assistant response in tokens/sec. */
  speed?: number;
  /**
   * Set while the agent waits on the human: a permission approval prompt
   * (pi-permission-system) or an ask_user_question (e.g. rpiv-ask-user-question).
   * The turn is NOT finished — it resumes once the user interacts.
   */
  waitingUser?: BridgeWaitingUser | null;
}

function emptyUsage(): BridgeUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsage(target: BridgeUsage, usage: ProviderUsage): void {
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.cost += usage.cost?.total ?? 0;
}

/**
 * Cumulative usage across the session file. Mirrors pi's own footer totals:
 * assistant message usage plus tool-result and compaction/branch-summary usage.
 */
function computeUsageFromEntries(ctx: ExtensionContext): BridgeUsage {
  const totals = emptyUsage();
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      addUsage(totals, entry.message.usage);
    } else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
      addUsage(totals, entry.message.usage);
    } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
      addUsage(totals, entry.usage);
    }
  }
  return totals;
}

/** Cache hit rate (0-100) of the latest assistant response in the session file. */
function latestCacheHitRate(ctx: ExtensionContext): number | undefined {
  let rate: number | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const usage = entry.message.usage;
    const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    rate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
  }
  return rate;
}

const CHARS_PER_TOKEN = 4;
const SPEED_LIVE_INTERVAL_MS = 500;
/** When the current assistant message started (message_start). */
let messageStartTs = 0;
/** When the first streamed delta arrived (excludes time-to-first-token). */
let firstTokenTs = 0;
let lastSpeedReportTs = 0;
/** Characters streamed so far (text + thinking + tool calls), for live estimates. */
let streamCharCount = 0;

function resetSpeedTracking(): void {
  messageStartTs = 0;
  firstTokenTs = 0;
  lastSpeedReportTs = 0;
  streamCharCount = 0;
}

/** Elapsed generation time in ms (from first token, falling back to message start). */
function speedElapsedMs(): number {
  return firstTokenTs || messageStartTs ? Date.now() - (firstTokenTs || messageStartTs) : 0;
}

function contextUsageOf(ctx: ExtensionContext): BridgeContext | undefined {
  const usage = ctx.getContextUsage();
  if (!usage) return undefined;
  return { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent };
}

let lastTarget = "";
let lastState = "";
let currentState: BridgeState = { status: "idle" };
/** Cumulative usage of the current session; reseeded from the session file on start. */
let sessionUsage: BridgeUsage = emptyUsage();
let sessionCacheHitRate: number | undefined;
let writeChain: Promise<void> = Promise.resolve();

/**
 * Elapsed-time suffix appended to pi's inline working indicator while a task
 * runs (agent_start .. agent_settled). The loader re-renders every 80ms for
 * the spinner, so a once-per-second message update adds negligible cost.
 */
const WORKING_TIMER_INTERVAL_MS = 1_000;
let workingStartedAt = 0;
let workingTimer: ReturnType<typeof setInterval> | undefined;

function formatWorkingElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}

function stopWorkingTimer(): void {
  if (workingTimer !== undefined) {
    clearInterval(workingTimer);
    workingTimer = undefined;
  }
  workingStartedAt = 0;
}

/**
 * Show the elapsed time to the right of the working animation. Keeps the
 * running total across retries/compactions: a second agent_start while the
 * timer is already running only refreshes the label, it does not reset it.
 */
function startWorkingTimer(ctx: ExtensionContext): void {
  const refresh = () => {
    ctx.ui.setWorkingMessage(`Working... ${formatWorkingElapsed(Date.now() - workingStartedAt)}`);
  };
  if (workingTimer !== undefined) {
    refresh();
    return;
  }
  workingStartedAt = Date.now();
  refresh();
  workingTimer = setInterval(refresh, WORKING_TIMER_INTERVAL_MS);
}

function activityTarget(sessionFile: string | undefined): string | undefined {
  if (!sessionFile) return undefined;
  return join(dirname(sessionFile), `${basename(sessionFile)}${ACTIVITY_SUFFIX}`);
}

function reportState(ctx: ExtensionContext, patch: Partial<BridgeState>): void {
  const target = activityTarget(ctx.sessionManager.getSessionFile());
  if (!target) return;
  if (target !== lastTarget) currentState = { status: "idle" };
  currentState = { ...currentState, ...patch };
  const serializedState = JSON.stringify(currentState);
  if (target === lastTarget && serializedState === lastState) return;
  lastTarget = target;
  lastState = serializedState;
  const payload = JSON.stringify({ ...currentState, ts: Date.now() });
  const tmp = `${target}.tmp`;
  writeChain = writeChain.then(async () => {
    await writeFile(tmp, payload, "utf8");
    await rename(tmp, target);
  });
}

async function clearActivity(ctx: ExtensionContext): Promise<void> {
  const target = activityTarget(ctx.sessionManager.getSessionFile());
  if (!target) return;
  await rm(target, { force: true }).catch(() => undefined);
}

// ── Waiting-on-human detection ──────────────────────────────────────────────
//
// Both kinds of "pi is blocked on the human" prompts broadcast on pi's shared
// extension event bus, so the bridge can mirror them into the activity sidecar
// without importing either package:
//
//  - pi-permission-system (@gotgenes/pi-permission-system) emits
//    `permissions:ui_prompt` immediately before its approval UI shows, and
//    `permissions:decision` after the gate resolves.
//  - @juicesharp/rpiv-ask-user-question emits `rpiv:ask-user:prompt` while the
//    questionnaire is awaiting input, and `rpiv:ask-user:blocked` with
//    `{ active: false }` when the wait ends.
//
// The generic `ask_user_question` tool_call/tool_result hooks below cover any
// other package that registers the same tool name. These events are NOT task
// completion: the session stays busy and continues once the user interacts.

/** Channel of pi-permission-system's UI-prompt broadcast. */
const PERMISSIONS_UI_PROMPT_CHANNEL = "permissions:ui_prompt";
/** Channel of pi-permission-system's gate-resolution broadcast. */
const PERMISSIONS_DECISION_CHANNEL = "permissions:decision";
/** Channel of rpiv-ask-user-question's awaiting-input broadcast. */
const ASK_USER_PROMPT_CHANNEL = "rpiv:ask-user:prompt";
/** Channel of rpiv-ask-user-question's wait-ended broadcast. */
const ASK_USER_BLOCKED_CHANNEL = "rpiv:ask-user:blocked";

/** The canonical name every ask_user_question package registers. */
const ASK_USER_TOOL_NAME = "ask_user_question";

/** Collapse whitespace and cap the notification detail line. */
function shortDetail(value: unknown, maxLength = 80): string | undefined {
  if (typeof value !== "string") return undefined;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength)}…` : collapsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** First question text from an ask_user_question payload, when present. */
function questionDetail(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const questions = input.questions;
  if (Array.isArray(questions)) {
    for (const entry of questions) {
      if (isRecord(entry) && typeof entry.question === "string" && entry.question.trim()) {
        return shortDetail(entry.question);
      }
    }
  }
  return shortDetail(input.question);
}

/** The extension context of the live session; undefined between sessions. */
let activeCtx: ExtensionContext | undefined;

/**
 * ReportState for event-bus listeners, which receive no ExtensionContext.
 * No-ops outside a session (the sidecar belongs to a session file).
 */
function reportStateFromActive(patch: Partial<BridgeState>): void {
  if (!activeCtx) return;
  reportState(activeCtx, patch);
}

class EmptyComponent implements Component {
  render(): string[] {
    return [];
  }
  invalidate(): void {}
}

class DesktopEditor extends CustomEditor {
  override render(): string[] {
    return [""];
  }
}

const imageMime: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

export default function ePiBridge(pi: ExtensionAPI): void {
  pi.registerCommand("e-pi-thinking", {
    description: "Set E-Pi thinking level",
    handler: async (args) => {
      const level = args?.trim() as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
      if (["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level)) {
        pi.setThinkingLevel(level);
      }
    },
  });

  pi.registerCommand("e-pi-attach", {
    description: "Send a prompt with image attachments from E-Pi",
    handler: async (args) => {
      if (!args?.trim()) return;
      const payload = JSON.parse(Buffer.from(args.trim(), "base64").toString("utf8")) as {
        text: string;
        images: string[];
      };
      const prompt = payload.text || "Review the attached images.";
      const imageBlocks: Array<{ type: "image"; data: string; mimeType: string }> = [];
      const imageNames: string[] = [];
      for (const path of payload.images) {
        const data = (await readFile(path)).toString("base64");
        const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
        imageBlocks.push({ type: "image", data, mimeType: imageMime[ext] || "image/png" });
        imageNames.push(path.slice(path.lastIndexOf("/") + 1));
      }
      // The TUI renders user messages as text only (image blocks are sent to
      // the model but never drawn), so surface the attachment names in the
      // visible text too.
      const label = imageNames.length > 0 ? `\n\n[Attached images: ${imageNames.join(", ")}]` : "";
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
        { type: "text", text: `${prompt}${label}` },
        ...imageBlocks,
      ];
      pi.sendUserMessage(content);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    activeCtx = ctx;
    ctx.ui.setHeader(() => new EmptyComponent());
    ctx.ui.setFooter(() => new EmptyComponent());
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new DesktopEditor(tui, theme, keybindings));
    // Reseed usage from the session file so totals survive process restarts.
    sessionUsage = computeUsageFromEntries(ctx);
    sessionCacheHitRate = latestCacheHitRate(ctx);
    // Seed the sidecar with the session's restored model, thinking level,
    // supported levels, usage, and idle state. waitingUser starts null so a
    // stale value from a previous run never bleeds into the fresh session.
    reportState(ctx, {
      status: "idle",
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
      thinkingLevel: ctx.thinkingLevel,
      supportedThinkingLevels: supportedThinkingLevelsOf(ctx.model),
      context: contextUsageOf(ctx),
      usage: sessionUsage,
      cacheHitRate: sessionCacheHitRate,
      waitingUser: null,
    });
  });

  pi.on("model_select", (event, ctx) => {
    reportState(ctx, {
      model: { provider: event.model.provider, id: event.model.id },
      supportedThinkingLevels: supportedThinkingLevelsOf(event.model),
    });
  });

  // Keep the sidecar in sync when the level changes (Shift+Tab, /thinking,
  // or the E-Pi composer selector via /e-pi-thinking).
  pi.on("thinking_level_select", (event, ctx) => {
    reportState(ctx, { thinkingLevel: event.level });
  });

  pi.on("agent_start", (_event, ctx) => {
    // Elapsed-time suffix on the working indicator; safe regardless of whether
    // this extension event fires before or after the core creates the
    // indicator (setWorkingMessage persists the label either way).
    startWorkingTimer(ctx);
    reportState(ctx, { status: "busy" });
  });

  // agent_settled fires only when no retry, compaction retry, or queued
  // follow-up remains, so it is the right "fully done" signal for a status UI.
  pi.on("agent_settled", (_event, ctx) => {
    stopWorkingTimer();
    ctx.ui.setWorkingMessage("Working...");
    reportState(ctx, {
      status: "idle",
      context: contextUsageOf(ctx),
      usage: sessionUsage,
      cacheHitRate: sessionCacheHitRate,
    });
  });

  // A permission gate (pi-permission-system) is about to show its approval
  // UI: the turn is blocked on the human, not finished.
  pi.events.on(PERMISSIONS_UI_PROMPT_CHANNEL, (data) => {
    const event = isRecord(data) ? data : undefined;
    const detail = shortDetail(event?.value) ?? shortDetail(event?.message);
    reportStateFromActive({ waitingUser: { kind: "permission", detail } });
  });
  // The gate resolved (approved, denied, session grant, …): the wait is over.
  pi.events.on(PERMISSIONS_DECISION_CHANNEL, () => {
    reportStateFromActive({ waitingUser: null });
  });
  // rpiv-ask-user-question: the questionnaire is awaiting input. The blocked
  // broadcast carries no content, so keep the detail from the prompt event.
  pi.events.on(ASK_USER_PROMPT_CHANNEL, (data) => {
    const detail = questionDetail(data);
    reportStateFromActive({ waitingUser: { kind: "ask_user", detail } });
  });
  pi.events.on(ASK_USER_BLOCKED_CHANNEL, (data) => {
    if (isRecord(data) && data.active === true) {
      reportStateFromActive({ waitingUser: { kind: "ask_user", detail: currentState.waitingUser?.detail } });
    } else {
      reportStateFromActive({ waitingUser: null });
    }
  });
  // Fallback for any other ask_user_question implementation: the tool call
  // blocks the turn until the human answers, so mirror the wait on the call
  // and clear it on the result.
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== ASK_USER_TOOL_NAME) return;
    reportState(ctx, { waitingUser: { kind: "ask_user", detail: questionDetail(event.input) } });
  });
  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== ASK_USER_TOOL_NAME) return;
    if (currentState.waitingUser?.kind !== "ask_user") return;
    reportState(ctx, { waitingUser: null });
  });

  pi.on("message_start", (event, _ctx) => {
    if (event.message.role !== "assistant") return;
    resetSpeedTracking();
    messageStartTs = Date.now();
  });

  // While streaming, report a live tokens/sec estimate (chars/4). The exact
  // number is computed from usage.output at message_end.
  pi.on("message_update", (event, ctx) => {
    const ev = event.assistantMessageEvent;
    if (ev.type !== "text_delta" && ev.type !== "thinking_delta" && ev.type !== "toolcall_delta") return;
    if (!firstTokenTs) firstTokenTs = Date.now();
    streamCharCount += ev.delta.length;
    const now = Date.now();
    if (now - lastSpeedReportTs < SPEED_LIVE_INTERVAL_MS) return;
    lastSpeedReportTs = now;
    const elapsed = speedElapsedMs();
    if (elapsed <= 0) return;
    const estimate = streamCharCount / CHARS_PER_TOKEN / (elapsed / 1000);
    if (estimate > 0) reportState(ctx, { speed: estimate });
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant") {
      addUsage(sessionUsage, event.message.usage);
      const usage = event.message.usage;
      const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
      sessionCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
      const elapsed = speedElapsedMs();
      const tokens = usage.output || Math.round(streamCharCount / CHARS_PER_TOKEN);
      if (elapsed > 0 && tokens > 0) {
        reportState(ctx, { speed: tokens / (elapsed / 1000) });
      }
      resetSpeedTracking();
    }
    reportState(ctx, {
      context: contextUsageOf(ctx),
      usage: sessionUsage,
      cacheHitRate: sessionCacheHitRate,
    });
  });

  pi.on("session_compact", (event, ctx) => {
    if (event.compactionEntry.usage) addUsage(sessionUsage, event.compactionEntry.usage);
    reportState(ctx, {
      context: contextUsageOf(ctx),
      usage: sessionUsage,
      cacheHitRate: sessionCacheHitRate,
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopWorkingTimer();
    activeCtx = undefined;
    void clearActivity(ctx);
  });
}
