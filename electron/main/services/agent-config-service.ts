import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { app } from "electron";

import type { AgentThinkingLevel, PiAgentConfig } from "../../../src/types/contracts";

/**
 * E-Pi-managed Pi Agent configuration. Lives in the app's userData directory
 * (not `~/.pi`), so the settings only apply to sessions E-Pi launches — the
 * same process that spawns pi reads this file when building the CLI args.
 *
 * The replace/append prompt fields map to `--system-prompt` and
 * `--append-system-prompt`; the other fields map to `--thinking` and
 * `--no-context-files`.
 */
export const AGENT_CONFIG_DEFAULTS: PiAgentConfig = {
  systemPrompt: "",
  appendSystemPrompt: "",
  thinkingLevel: "",
  contextFiles: true,
};

const THINKING_LEVELS: readonly AgentThinkingLevel[] = ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

function agentConfigPath(): string {
  return join(app.getPath("userData"), "agent-config.json");
}

function sanitizeConfig(input: unknown): PiAgentConfig {
  if (typeof input !== "object" || input === null) return { ...AGENT_CONFIG_DEFAULTS };
  const raw = input as Record<string, unknown>;
  return {
    systemPrompt: typeof raw.systemPrompt === "string" ? raw.systemPrompt : AGENT_CONFIG_DEFAULTS.systemPrompt,
    appendSystemPrompt:
      typeof raw.appendSystemPrompt === "string" ? raw.appendSystemPrompt : AGENT_CONFIG_DEFAULTS.appendSystemPrompt,
    thinkingLevel: THINKING_LEVELS.includes(raw.thinkingLevel as AgentThinkingLevel)
      ? (raw.thinkingLevel as AgentThinkingLevel)
      : AGENT_CONFIG_DEFAULTS.thinkingLevel,
    contextFiles: typeof raw.contextFiles === "boolean" ? raw.contextFiles : AGENT_CONFIG_DEFAULTS.contextFiles,
  };
}

let cached: PiAgentConfig | undefined;

export async function getAgentConfig(): Promise<PiAgentConfig> {
  if (cached) return { ...cached };
  try {
    const raw = await readFile(agentConfigPath(), "utf8");
    cached = sanitizeConfig(JSON.parse(raw) as unknown);
  } catch {
    // Missing or malformed file — fall back to defaults.
    cached = { ...AGENT_CONFIG_DEFAULTS };
  }
  return { ...cached };
}

export async function saveAgentConfig(config: PiAgentConfig): Promise<PiAgentConfig> {
  const next = sanitizeConfig(config);
  const path = agentConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2), "utf8");
  cached = { ...next };
  return { ...next };
}

/**
 * Resolve the CLI flags that should be added to a session's pi launch,
 * derived from the stored config. Kept here so `PiRuntime` only has to await
 * one call before spawning the process.
 */
export function agentConfigToArgs(config: PiAgentConfig): string[] {
  const args: string[] = [];
  if (config.systemPrompt.trim()) {
    args.push("--system-prompt", config.systemPrompt);
  }
  if (config.appendSystemPrompt.trim()) {
    args.push("--append-system-prompt", config.appendSystemPrompt);
  }
  if (config.thinkingLevel) {
    args.push("--thinking", config.thinkingLevel);
  }
  if (!config.contextFiles) {
    args.push("--no-context-files");
  }
  return args;
}
