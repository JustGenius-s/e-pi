import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

import type { CommandArgumentOption, CommandRecord } from "../../../src/types/contracts";
import { loadPiAgent, type PiAgent } from "./pi-agent-loader";

type ParseFrontmatter = PiAgent["parseFrontmatter"];

/** How long cached discoveries (plugin commands, the ModelRuntime) stay fresh. */
const CACHE_TTL_MS = 30_000;

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
function loadTemplateFromFile(
  filePath: string,
  parseFrontmatter: ParseFrontmatter,
): { name: string; description: string; argumentHint?: string } | null {
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
function loadTemplatesFromDir(
  dir: string,
  parseFrontmatter: ParseFrontmatter,
): Array<{ name: string; description: string; argumentHint?: string }> {
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
      const template = loadTemplateFromFile(fullPath, parseFrontmatter);
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

/** Minimal structural subset of ModelRuntime we call for completions. */
type ModelRuntimeLike = {
  refresh(options: { allowNetwork?: boolean }): Promise<unknown>;
  getAvailable(): Promise<readonly { id: string; provider: string; name: string }[]>;
  getAvailableSnapshot(): readonly { id: string; provider: string; name: string }[];
  getProviders(): readonly { id: string; name: string; auth?: { oauth?: unknown; apiKey?: unknown } }[];
};

export class CommandService {
  /** Extension commands are expensive (jiti compile + factory run); cache per cwd. */
  #pluginCache = new Map<string, { at: number; records: CommandRecord[] }>();
  /**
   * Extensions' `getArgumentCompletions` callbacks, keyed by command name.
   * Filled by the same discovery pass as #loadPluginCommands; cleared with it.
   */
  #pluginArgumentCompletions = new Map<string, (prefix: string) => unknown>();
  /** Cached ModelRuntime for argument completions; recreated when it goes stale. */
  #modelRuntime?: { at: number; runtime: ModelRuntimeLike };

  async list(cwd: string): Promise<CommandRecord[]> {
    const records: CommandRecord[] = [];
    for (const command of BUILTIN_COMMANDS) {
      records.push({ ...command, source: "builtin" });
    }
    for (const template of await this.#loadTemplates(cwd)) {
      records.push({ ...template, source: "template" });
    }
    records.push(...(await this.#loadPluginCommands(cwd)));
    return records;
  }

  /**
   * Argument completions for a slash command, mirroring pi's
   * `CombinedAutocompleteProvider`: `/model` completes the scoped model list,
   * `/login` completes provider ids, and extension commands can register their
   * own `getArgumentCompletions`. Returns null when the command has none.
   */
  async argumentCompletions(
    cwd: string,
    command: string,
    argumentPrefix: string,
  ): Promise<CommandArgumentOption[] | null> {
    if (command === "model") return this.#modelCompletions(argumentPrefix);
    if (command === "login") return this.#loginCompletions(argumentPrefix);
    const handler = (await this.#pluginArgumentCompletionsFor(cwd)).get(command);
    if (!handler) return null;
    try {
      const options = await handler(argumentPrefix);
      return normalizeArgumentOptions(options);
    } catch {
      return null;
    }
  }

  /**
   * Fuzzy model list for `/model`: the full available model list (pi's
   * per-session scoped models aren't reachable from here). The available
   * snapshot is refreshed (offline) so newly logged-in providers show up;
   * the runtime itself is cached briefly to keep typing snappy.
   */
  async #modelCompletions(prefix: string): Promise<CommandArgumentOption[] | null> {
    try {
      const runtime = await this.#modelRuntimeFor();
      await runtime.refresh({ allowNetwork: false });
      const snapshot = runtime.getAvailableSnapshot();
      const models = snapshot.length > 0 ? snapshot : await runtime.getAvailable();
      const items = models.map((model) => ({
        id: model.id,
        provider: model.provider,
        name: model.name ?? "",
        label: `${model.provider}/${model.id}`,
      }));
      const options = fuzzyFilter(items, prefix, (item) => `${item.provider}/${item.id} ${item.name}`);
      return options.map((item) => ({
        value: item.label,
        label: item.id,
        description: item.provider,
      }));
    } catch {
      return null;
    }
  }

  /**
   * Provider ids for `/login`, mirroring pi's `getLoginProviderCompletionOptions`
   * (providers with oauth and/or api_key auth, deduped by id, sorted by name).
   */
  async #loginCompletions(prefix: string): Promise<CommandArgumentOption[] | null> {
    try {
      const runtime = await this.#modelRuntimeFor();
      const byId = new Map<string, { id: string; name: string }>();
      for (const provider of runtime.getProviders()) {
        if (!provider.auth?.oauth && !provider.auth?.apiKey) continue;
        if (!byId.has(provider.id)) byId.set(provider.id, { id: provider.id, name: provider.name });
      }
      const providers = Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
      const options = fuzzyFilter(providers, prefix, (provider) => provider.id);
      return options.map((provider) => ({ value: provider.id, label: provider.id }));
    } catch {
      return null;
    }
  }

  /** Cached ModelRuntime bound to the agent dir, recreated when stale. */
  async #modelRuntimeFor(): Promise<ModelRuntimeLike> {
    const { ModelRuntime } = await loadPiAgent();
    if (this.#modelRuntime && Date.now() - this.#modelRuntime.at < CACHE_TTL_MS) {
      return this.#modelRuntime.runtime;
    }
    // Defaults already point at the agent dir (models.json, auth.json).
    const runtime = (await ModelRuntime.create({})) as ModelRuntimeLike;
    this.#modelRuntime = { at: Date.now(), runtime };
    return runtime;
  }

  /**
   * Loads extension argument-completion callbacks (jiti compile + factory run
   * per cwd, cached briefly like the command list).
   */
  async #pluginArgumentCompletionsFor(cwd: string): Promise<Map<string, (prefix: string) => unknown>> {
    if (this.#pluginCache.has(cwd)) {
      const cached = this.#pluginCache.get(cwd)!;
      if (Date.now() - cached.at < CACHE_TTL_MS) return this.#pluginArgumentCompletions;
    }
    await this.#loadPluginCommands(cwd);
    return this.#pluginArgumentCompletions;
  }

  /**
   * Extension commands registered via `pi.registerCommand` at factory time,
   * discovered the same way pi's resource loader does: configured packages
   * (via DefaultPackageManager) + explicit settings `extensions` paths, plus
   * the project/global extensions dirs scanned by discoverAndLoadExtensions.
   */
  async #loadPluginCommands(cwd: string): Promise<CommandRecord[]> {
    const cached = this.#pluginCache.get(cwd);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.records;

    const records: CommandRecord[] = [];
    const argumentCompletions = new Map<string, (prefix: string) => unknown>();
    try {
      const { DefaultPackageManager, SettingsManager, discoverAndLoadExtensions, getAgentDir } = await loadPiAgent();
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
          if (command.getArgumentCompletions) {
            argumentCompletions.set(command.name, command.getArgumentCompletions);
          }
        }
      }
    } catch {
      // Extension discovery must never break the command list; fall back to
      // builtins + templates for this cycle.
    }

    this.#pluginCache.set(cwd, { at: Date.now(), records });
    this.#pluginArgumentCompletions = argumentCompletions;
    return records;
  }

  async #loadTemplates(cwd: string): Promise<Array<{ name: string; description: string; argumentHint?: string }>> {
    const { CONFIG_DIR_NAME, SettingsManager, getAgentDir, parseFrontmatter } = await loadPiAgent();
    const agentDir = getAgentDir();
    const globalPromptsDir = join(agentDir, "prompts");
    const projectPromptsDir = resolve(cwd, CONFIG_DIR_NAME, "prompts");
    const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const promptPaths = settings.getPromptTemplatePaths() ?? [];

    const templates: Array<{ name: string; description: string; argumentHint?: string }> = [];
    templates.push(...loadTemplatesFromDir(globalPromptsDir, parseFrontmatter));
    templates.push(...loadTemplatesFromDir(projectPromptsDir, parseFrontmatter));

    // Explicit prompt paths (settings `prompts` array): files or directories.
    const seen = new Set(templates.map((template) => template.name));
    for (const rawPath of promptPaths) {
      const resolvedPath = resolve(cwd, rawPath);
      if (!existsSync(resolvedPath)) continue;
      try {
        const stats = statSync(resolvedPath);
        if (stats.isDirectory()) {
          for (const template of loadTemplatesFromDir(resolvedPath, parseFrontmatter)) {
            if (!seen.has(template.name)) {
              seen.add(template.name);
              templates.push(template);
            }
          }
        } else if (stats.isFile() && extname(resolvedPath).toLowerCase() === ".md") {
          const template = loadTemplateFromFile(resolvedPath, parseFrontmatter);
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

/**
 * Minimal fuzzy filter: case-insensitive substring match on the search text,
 * keeping the items' original order (no scoring, unlike pi-tui's fuzzyFilter).
 */
function fuzzyFilter<T>(items: T[], query: string, getSearchText: (item: T) => string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((item) => getSearchText(item).toLowerCase().includes(needle));
}

/**
 * Normalizes a pi extension's `getArgumentCompletions` result (either
 * `AutocompleteItem[]` or null) into e-pi's CommandArgumentOption[].
 */
function normalizeArgumentOptions(options: unknown): CommandArgumentOption[] | null {
  if (!Array.isArray(options) || options.length === 0) return null;
  const normalized: CommandArgumentOption[] = [];
  for (const option of options) {
    if (typeof option !== "object" || option === null) continue;
    const { value, label, description } = option as Record<string, unknown>;
    if (typeof value !== "string" || !value) continue;
    normalized.push({
      value,
      label: typeof label === "string" && label ? label : value,
      ...(typeof description === "string" && description ? { description } : {}),
    });
  }
  return normalized.length > 0 ? normalized : null;
}
