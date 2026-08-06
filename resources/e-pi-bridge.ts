import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

/** Thinking levels pi exposes (mirrors pi's own ThinkingLevel union). */
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Full ordered set of thinking levels pi knows about. */
const EXTENDED_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

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
      // Read each image independently: a missing/unreadable file (e.g. the
      // temp paste file was cleaned up before send) must not silently drop
      // the whole message — report the failure in the text instead.
      const imageBlocks: Array<{ type: "image"; data: string; mimeType: string }> = [];
      const failures: string[] = [];
      await Promise.all(
        payload.images.map(async (path) => {
          try {
            const data = (await readFile(path)).toString("base64");
            const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
            imageBlocks.push({
              type: "image" as const,
              data,
              mimeType: imageMime[ext] || "image/png",
            });
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            failures.push(`[Image attachment could not be read: ${path} (${reason})]`);
          }
        }),
      );
      // pi's TUI only renders text blocks of a user message (image blocks get
      // no indicator), so prepend a textual marker per successfully attached
      // image — mirroring the "Attached path:" lines the composer adds for
      // regular file attachments.
      const markers = payload.images
        .filter((path) => !failures.some((f) => f.includes(path)))
        .map((path) => `Attached image: ${path}`);
      const parts = [...markers, prompt, ...failures].filter(Boolean);
      const text = parts.join("\n");
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
        { type: "text", text },
        ...imageBlocks,
      ];
      pi.sendUserMessage(content);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setHeader(() => new EmptyComponent());
    ctx.ui.setFooter(() => new EmptyComponent());
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new DesktopEditor(tui, theme, keybindings));
    // Reseed usage from the session file so totals survive process restarts.
    sessionUsage = computeUsageFromEntries(ctx);
    sessionCacheHitRate = latestCacheHitRate(ctx);
    // Seed the sidecar with the session's restored model, thinking level,
    // supported levels, usage, and idle state.
    reportState(ctx, {
      status: "idle",
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
      thinkingLevel: ctx.thinkingLevel,
      supportedThinkingLevels: supportedThinkingLevelsOf(ctx.model),
      context: contextUsageOf(ctx),
      usage: sessionUsage,
      cacheHitRate: sessionCacheHitRate,
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
    reportState(ctx, { status: "busy" });
  });

  // agent_settled fires only when no retry, compaction retry, or queued
  // follow-up remains, so it is the right "fully done" signal for a status UI.
  pi.on("agent_settled", (_event, ctx) => {
    reportState(ctx, {
      status: "idle",
      context: contextUsageOf(ctx),
      usage: sessionUsage,
      cacheHitRate: sessionCacheHitRate,
    });
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
    void clearActivity(ctx);
  });
}
