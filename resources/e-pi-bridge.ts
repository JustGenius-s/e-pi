import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

const ACTIVITY_SUFFIX = ".e-pi-activity.json";

/**
 * Per-session activity reporting. Writes a tiny JSON sidecar next to the
 * session file so the Electron main process can show "working vs idle" for
 * sessions that run in the background. `SessionManager.listAll` only picks up
 * `.jsonl` files, so the sidecar never appears as a session.
 */
interface BridgeState {
  status: "busy" | "idle";
  model?: { provider: string; id: string };
}

let lastTarget = "";
let lastState = "";
let currentState: BridgeState = { status: "idle" };
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
      const imageBlocks = await Promise.all(
        payload.images.map(async (path) => {
          const data = (await readFile(path)).toString("base64");
          const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
          return {
            type: "image" as const,
            data,
            mimeType: imageMime[ext] || "image/png",
          };
        }),
      );
      const content: Array<
        { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
      > = [{ type: "text", text: prompt }, ...imageBlocks];
      pi.sendUserMessage(content);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setHeader(() => new EmptyComponent());
    ctx.ui.setFooter(() => new EmptyComponent());
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) => new DesktopEditor(tui, theme, keybindings),
    );
    // Seed the sidecar with the session's restored model and idle state.
    reportState(ctx, {
      status: "idle",
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
    });
  });

  pi.on("model_select", (event, ctx) => {
    reportState(ctx, { model: { provider: event.model.provider, id: event.model.id } });
  });

  pi.on("agent_start", (_event, ctx) => {
    reportState(ctx, { status: "busy" });
  });

  // agent_settled fires only when no retry, compaction retry, or queued
  // follow-up remains, so it is the right "fully done" signal for a status UI.
  pi.on("agent_settled", (_event, ctx) => {
    reportState(ctx, { status: "idle" });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    void clearActivity(ctx);
  });
}
