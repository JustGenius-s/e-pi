import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import ePiBridge from "../resources/e-pi-bridge";

function loadBridge() {
  const commands = new Map<string, { handler: (args: string, ctx?: { isIdle: () => boolean }) => Promise<void> }>();
  const sendUserMessage = vi.fn();
  const pi = {
    registerTool: vi.fn(),
    registerCommand: vi.fn(
      (name: string, spec: { handler: (args: string, ctx?: { isIdle: () => boolean }) => Promise<void> }) => {
        commands.set(name, spec);
      },
    ),
    setThinkingLevel: vi.fn(),
    sendUserMessage,
    on: vi.fn(),
    events: { on: vi.fn() },
  } as never;
  ePiBridge(pi as never);
  return { commands, sendUserMessage };
}

function attachArgs(text: string, images: string[]): string {
  return Buffer.from(JSON.stringify({ text, images }), "utf8").toString("base64");
}

describe("e-pi-attach sendUserMessage", () => {
  const dir = mkdtempSync(join(tmpdir(), "epi-bridge-attach-"));
  const imagePath = join(dir, "shot.png");

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers the e-pi-attach command", () => {
    const { commands } = loadBridge();
    expect(commands.has("e-pi-attach")).toBe(true);
  });

  it("queues the image message as followUp so a busy agent does not throw", async () => {
    writeFileSync(imagePath, "png-bytes");
    const { commands, sendUserMessage } = loadBridge();
    await commands.get("e-pi-attach")!.handler(attachArgs("look at this", [imagePath]));

    expect(sendUserMessage).toHaveBeenCalledOnce();
    const [content, options] = sendUserMessage.mock.calls[0] as [
      Array<{ type: string; text?: string; mimeType?: string }>,
      { deliverAs?: string },
    ];
    expect(options).toEqual({ deliverAs: "followUp" });
    expect(content[0]).toMatchObject({ type: "text" });
    expect(content[0].text).toContain("look at this");
    // Paste files live in OS temp (e-pi-paste-*.png), not the workspace.
    // A basename-only label makes read tools open {cwd}/shot.png and ENOENT.
    expect(content[0].text).toContain(`Attached image: ${imagePath}`);
    expect(content[0].text).not.toContain("[Attached images:");
    expect(content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
  });

  it("reports an unreadable image instead of dropping the whole message", async () => {
    const missing = join(dir, "gone.png");
    const { commands, sendUserMessage } = loadBridge();
    await commands.get("e-pi-attach")!.handler(attachArgs("still send this", [missing]));

    expect(sendUserMessage).toHaveBeenCalledOnce();
    const [content, options] = sendUserMessage.mock.calls[0] as [
      Array<{ type: string; text?: string; mimeType?: string }>,
      { deliverAs?: string },
    ];
    expect(options).toEqual({ deliverAs: "followUp" });
    expect(content).toHaveLength(1);
    expect(content[0].text).toContain("still send this");
    expect(content[0].text).toContain("Image attachment could not be read");
    expect(content[0].text).toContain(missing);
  });
});
