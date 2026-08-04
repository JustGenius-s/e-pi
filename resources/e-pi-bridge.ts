import { readFile } from "node:fs/promises";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

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
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
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
  });
}
