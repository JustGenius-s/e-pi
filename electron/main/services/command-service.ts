import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

import {
  CONFIG_DIR_NAME,
  DefaultPackageManager,
  discoverAndLoadExtensions,
  getAgentDir,
  parseFrontmatter,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import type { CommandRecord } from "../../../src/types/contracts";

/** How long resolved plugin commands are kept before re-discovering. */
const PLUGIN_CACHE_TTL_MS = 30_000;

/**
 * Mirrors pi's built-in interactive slash commands (dist/core/slash-commands.js)
 * so the composer's command list matches what the TUI shows when you type "/".
 */
const BUILTIN_COMMANDS: Array<{ name: string; description: string; argumentHint?: string }> = [
  { name: "settings", description: "Open settings menu" },
  { name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },
  { name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
  { name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
  { name: "import", description: "Import and resume a session from a JSONL file" },
  { name: "share", description: "Share session as a secret GitHub gist" },
  { name: "copy", description: "Copy last agent message to clipboard" },
  { name: "name", description: "Set session display name" },
  { name: "session", description: "Show session info and stats" },
  { name: "changelog", description: "Show changelog entries" },
  { name: "hotkeys", description: "Show all keyboard shortcuts" },
  { name: "fork", description: "Create a new fork from a previous user message" },
  { name: "clone", description: "Duplicate the current session at the current position" },
  { name: "tree", description: "Navigate session tree (switch branches)" },
  { name: "trust", description: "Save project trust decision for future sessions" },
  { name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },
  { name: "logout", description: "Remove provider authentication" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Manually compact the session context" },
  { name: "resume", description: "Resume a different session" },
  { name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
  { name: "quit", description: "Quit E-Pi" },
];

/** Parse a prompt template file, mirroring pi's loadTemplateFromFile(). */
function loadTemplateFromFile(filePath: string): { name: string; description: string; argumentHint?: string } | null {
  try {
    const rawContent = readFileSync(filePath, "utf8");
    const { frontmatter, body } = parseFrontmatter(rawContent);
    const name = basename(filePath).replace(/\.md$/, "");
    const rawDescription = frontmatter.description;
    let description = typeof rawDescription === "string" ? rawDescription : "";
    if (!description) {
      const firstLine = body.split("\n").find((line) => line.trim());
      if (firstLine) {
        description = firstLine.slice(0, 60);
        if (firstLine.length > 60) description += "...";
      }
    }
    const argumentHint = frontmatter["argument-hint"];
    return {
      name,
      description,
      ...(typeof argumentHint === "string" && argumentHint ? { argumentHint } : {}),
    };
  } catch {
    return null;
  }
}

/** Scan a directory for prompt templates (non-recursive), mirroring pi's loadTemplatesFromDir(). */
function loadTemplatesFromDir(dir: string): Array<{ name: string; description: string; argumentHint?: string }> {
  const templates: Array<{ name: string; description: string; argumentHint?: string }> = [];
  if (!existsSync(dir)) return templates;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.endsWith(".md")) continue;
      const fullPath = join(dir, entry.name);
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          isFile = statSync(fullPath).isFile();
        } catch {
          continue; // Broken symlink
        }
      }
      if (!isFile) continue;
      const template = loadTemplateFromFile(fullPath);
      if (template) templates.push(template);
    }
  } catch {
    return templates;
  }
  return templates;
}

/**
 * Discovers slash commands for the composer's command list. The data mirrors
 * what pi's TUI feeds its autocomplete provider: built-in slash commands,
 * prompt templates (global agent dir, project .pi dir, configured prompt
 * paths), and extension commands from packages, the global agent extensions
 * dir, project extensions dir, and configured extension paths.
 */
export class CommandService {
  /** Extension commands are expensive (jiti compile + factory run); cache per cwd. */
  #pluginCache = new Map<string, { at: number; records: CommandRecord[] }>();

  async list(cwd: string): Promise<CommandRecord[]> {
    const records: CommandRecord[] = [];
    for (const command of BUILTIN_COMMANDS) {
      records.push({ ...command, source: "builtin" });
    }
    for (const template of this.#loadTemplates(cwd)) {
      records.push({ ...template, source: "template" });
    }
    records.push(...(await this.#loadPluginCommands(cwd)));
    return records;
  }

  /**
   * Extension commands registered via `pi.registerCommand` at factory time,
   * discovered the same way pi's resource loader does: configured packages
   * (via DefaultPackageManager) + explicit settings `extensions` paths, plus
   * the project/global extensions dirs scanned by discoverAndLoadExtensions.
   */
  async #loadPluginCommands(cwd: string): Promise<CommandRecord[]> {
    const cached = this.#pluginCache.get(cwd);
    if (cached && Date.now() - cached.at < PLUGIN_CACHE_TTL_MS) return cached.records;

    const records: CommandRecord[] = [];
    try {
      const agentDir = getAgentDir();
      const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
      const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
      // Never auto-install missing packages just to fill the command list.
      const resolved = await manager.resolve(async () => "skip" as const);
      const configuredPaths = [
        ...resolved.extensions.filter((entry) => entry.enabled).map((entry) => entry.path),
        ...settingsManager.getExtensionPaths(),
      ];
      const { extensions } = await discoverAndLoadExtensions(configuredPaths, cwd, agentDir);
      const seen = new Set<string>();
      for (const extension of extensions) {
        for (const command of extension.commands.values()) {
          if (seen.has(command.name)) continue;
          seen.add(command.name);
          records.push({ name: command.name, description: command.description, source: "plugin" });
        }
      }
    } catch {
      // Extension discovery must never break the command list; fall back to
      // builtins + templates for this cycle.
    }

    this.#pluginCache.set(cwd, { at: Date.now(), records });
    return records;
  }

  #loadTemplates(cwd: string): Array<{ name: string; description: string; argumentHint?: string }> {
    const agentDir = getAgentDir();
    const globalPromptsDir = join(agentDir, "prompts");
    const projectPromptsDir = resolve(cwd, CONFIG_DIR_NAME, "prompts");
    const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const promptPaths = settings.getPromptTemplatePaths() ?? [];

    const templates: Array<{ name: string; description: string; argumentHint?: string }> = [];
    templates.push(...loadTemplatesFromDir(globalPromptsDir));
    templates.push(...loadTemplatesFromDir(projectPromptsDir));

    // Explicit prompt paths (settings `prompts` array): files or directories.
    const seen = new Set(templates.map((template) => template.name));
    for (const rawPath of promptPaths) {
      const resolvedPath = resolve(cwd, rawPath);
      if (!existsSync(resolvedPath)) continue;
      try {
        const stats = statSync(resolvedPath);
        if (stats.isDirectory()) {
          for (const template of loadTemplatesFromDir(resolvedPath)) {
            if (!seen.has(template.name)) {
              seen.add(template.name);
              templates.push(template);
            }
          }
        } else if (stats.isFile() && extname(resolvedPath).toLowerCase() === ".md") {
          const template = loadTemplateFromFile(resolvedPath);
          if (template && !seen.has(template.name)) {
            seen.add(template.name);
            templates.push(template);
          }
        }
      } catch {
        // Ignore unreadable prompt paths.
      }
    }
    return templates;
  }
}
