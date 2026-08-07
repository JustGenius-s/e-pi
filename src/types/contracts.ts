export type PiProcessStatus = "idle" | "starting" | "running" | "stopping" | "exited" | "error";

/** Agent activity inside a running pi process (reported by the bridge extension). */
export type PiActivityStatus = "busy" | "idle";

export interface ModelRef {
  provider: string;
  id: string;
}

/** Estimated context usage for the active model (reported by the bridge extension). */
export interface ContextUsageState {
  /** Estimated context tokens, or null when unknown (e.g. right after compaction). */
  tokens: number | null;
  contextWindow: number;
  /** Context usage as percentage of the window, or null when tokens are unknown. */
  percent: number | null;
}

/** Cumulative token usage for a session (reported by the bridge extension). */
export interface SessionUsageState {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface AppInfo {
  platform: NodeJS.Platform;
  arch: string;
  appVersion: string;
  piVersion: string;
  defaultCwd: string;
  /** User home directory; paths under it render as `~` in the UI. */
  homeDir: string;
  /** .app bundle path for the file tree's "open with"; undefined = system default. */
  openWithApp?: string;
}

export interface AppDescriptor {
  /** Stable identifier — the .app bundle path on macOS. */
  id: string;
  name: string;
  path: string;
  /** 32×32 PNG data URL of the app icon; undefined when extraction failed. */
  icon?: string;
}

export interface PiUpdateInfo {
  /** Version of the pi package bundled with E-Pi. */
  current: string;
  /** Newest published pi version; undefined when the check failed or none is newer. */
  latest?: string;
}

/** Result of applying a pi update. */
export interface PiUpdateResult {
  /** Previously bundled version. */
  from: string;
  /** Newly installed version. */
  to: string;
  /** Path to the package directory the new version was installed into. */
  path: string;
}

export interface SessionSummary {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  createdAt: string;
  modifiedAt: string;
  messageCount: number;
  firstMessage: string;
  searchText: string;
}

/**
 * A project groups several source folders/repos under one name, with a
 * primary repo that new sessions and git reviews target. Sessions stay bound
 * to their own cwd; the project is a label + routing layer on top.
 */
export interface Project {
  id: string;
  /** Display name; defaults to the primary repo's basename. */
  name?: string;
  /** All member folders/repos, ordered, de-duplicated. */
  folders: string[];
  /** Git/agent target; must be one of `folders`. */
  primaryRepo: string;
  createdAt: string;
}

export interface CreateProjectRequest {
  name?: string;
  folders: string[];
  primaryRepo: string;
}

export interface UpdateProjectRequest {
  id: string;
  name?: string;
  folders?: string[];
  primaryRepo?: string;
}

export interface PiRuntimeState {
  status: PiProcessStatus;
  /** Session path this state belongs to. Always set once the session is known. */
  sessionPath: string;
  cwd?: string;
  /** Monotonic counter; increments every time the session's pi process is (re)launched. */
  generation: number;
  /** Agent activity while the process is running: "busy" (streaming/working) or "idle". */
  activity?: PiActivityStatus;
  /** Model currently selected inside this session's Pi process. */
  model?: ModelRef;
  /** Current thinking level inside this session's Pi process (after model clamping). */
  thinkingLevel?: Exclude<AgentThinkingLevel, "">;
  /** Thinking levels the current model supports; drives the composer's thinking menu. */
  supportedThinkingLevels?: Exclude<AgentThinkingLevel, "">[];
  /** Context usage of the active model; reported while the process is running. */
  context?: ContextUsageState;
  /** Cumulative token usage for this session; reported while the process is running. */
  usage?: SessionUsageState;
  /** Cache hit rate (0-100) of the latest assistant response; undefined before the first one. */
  cacheHitRate?: number;
  /** Output speed (tokens/sec) of the latest assistant response; live estimate while streaming. */
  speed?: number;
  pid?: number;
  exitCode?: number;
  signal?: number;
  error?: string;
}

export interface PackageRecord {
  source: string;
  scope: "user" | "project";
  filtered: boolean;
  installedPath?: string;
  /** Installed version (from the package's package.json), when available. */
  version?: string;
  /** True when a newer version is available on the registry/remote. */
  hasUpdate?: boolean;
  /** Latest version on the registry, when known. */
  latestVersion?: string;
}

/** A configured package that has a newer version available. */
export interface PackageUpdateInfo {
  source: string;
  displayName: string;
  type: "npm" | "git";
  scope: "user" | "project";
  /** Latest version on the registry, when resolvable. */
  latestVersion?: string;
}

/** A package found via the npm registry search. */
export interface RemotePackageInfo {
  name: string;
  description?: string;
  version: string;
  /** ISO date of the latest publish. */
  date?: string;
  author?: string;
  keywords?: string[];
  /** Npm search popularity score (0-1). */
  popularity?: number;
}

/** Npm download stats for a package (api.npmjs.org point endpoint). */
export interface PackageDownloads {
  package: string;
  downloads: number;
  start: string;
  end: string;
}

export type PackageAction = "install" | "remove" | "update" | "clone" | "pull";

export interface PackageProgress {
  type: "start" | "progress" | "complete" | "error";
  action: PackageAction;
  source: string;
  message?: string;
}

export interface PackageMutation {
  source: string;
  cwd: string;
}

export interface PackageUpdateRequest {
  source?: string;
  cwd: string;
}

export interface CreateSessionRequest {
  cwd?: string;
}

export interface RenameSessionRequest {
  path: string;
  name: string;
}

export interface ResizeTerminalRequest {
  cols: number;
  rows: number;
}

export type ModelAuthType = "api_key" | "oauth";

export interface ModelRecord {
  provider: string;
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  available: boolean;
}

export interface ModelProviderRecord {
  id: string;
  name: string;
  configured: boolean;
  authSource?: string;
  storedAuthType?: ModelAuthType;
  supportsApiKey: boolean;
  supportsOAuth: boolean;
  apiKeyLabel?: string;
  oauthLabel?: string;
  models: ModelRecord[];
}

export interface ModelManagementState {
  providers: ModelProviderRecord[];
  defaultModel?: ModelRef;
  error?: string;
}

export type CommandSource = "builtin" | "template" | "plugin" | "skill";

/**
 * A slash command shown in the composer's command list. `name` is without the
 * leading "/", e.g. "model" or "skill:code-review". Mirrors the autocomplete
 * commands pi's TUI feeds to its editor.
 */
export interface CommandRecord {
  name: string;
  description?: string;
  /** Argument hint displayed next to the name, e.g. "<provider/model>". */
  argumentHint?: string;
  source: CommandSource;
}

/**
 * A value option for a slash command's argument, e.g. the model list for
 * "/model <provider/model>". Mirrors pi-tui's `AutocompleteItem` for
 * `getArgumentCompletions`. `value` is what gets inserted into the composer;
 * `label` and `description` are what the popup displays.
 */
export interface CommandArgumentOption {
  value: string;
  label: string;
  description?: string;
}

export type SkillScope = "user" | "project";

export type SkillSource = "user" | "project" | "path";

export interface SkillRecord {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: SkillSource;
  enabled: boolean;
  managed: boolean;
}

export interface SkillMutation {
  cwd: string;
  filePath: string;
}

export interface SkillSetEnabledRequest extends SkillMutation {
  enabled: boolean;
}

export interface SkillCreateRequest {
  cwd: string;
  scope: SkillScope;
  name: string;
  description: string;
}

export interface SkillAddPathRequest {
  cwd: string;
  scope: SkillScope;
  path: string;
}

export interface ModelLoginRequest {
  providerId: string;
  type: ModelAuthType;
}

export interface ModelLoginResponse {
  promptId: string;
  value: string;
}

export interface SetDefaultModelRequest extends ModelRef {
  /** Session that should switch immediately; defaults to the active session. */
  sessionPath?: string;
}

export interface CustomModelDefinition {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  /**
   * Supported thinking levels (pi levels minus "off"). Persisted as a
   * thinkingLevelMap: selected levels map to their effort string, unselected
   * levels map to null. Absent = let the provider default apply.
   */
  thinkingLevels?: string[];
  /** Image input support: persisted as input: ["text", "image"] in models.json. */
  vision?: boolean;
}

export interface CustomProviderConfig {
  id: string;
  name?: string;
  baseUrl: string;
  api: string;
  apiKey?: string;
  /** Send `Authorization: Bearer <apiKey>` for non-standard APIs. */
  authHeader?: boolean;
  models: CustomModelDefinition[];
}

export interface CustomProviderRequest {
  provider: CustomProviderConfig;
}

export interface CatalogMetaRequest {
  baseUrl: string;
  modelIds: string[];
}

/** Fetch the model list from an OpenAI-compatible /models endpoint. */
export interface FetchModelsRequest {
  baseUrl: string;
  apiKey?: string;
}

/** Curated model metadata from the models.dev community catalog. */
export interface ModelCatalogMeta {
  name?: string;
  reasoning?: boolean;
  /** True when the model accepts image input. */
  vision?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface CustomProviderRemoveRequest {
  providerId: string;
}

/** Git porcelain status letter: staged index status + worktree status. */
export interface GitFileEntry {
  /** Display path; renamed files show as "old -> new". */
  path: string;
  /** Path to use for git operations (the new path for renames). */
  workPath: string;
  /** Two-letter porcelain status, e.g. "M ", " M", "AM", "??", "UU". */
  status: string;
  staged: boolean;
  untracked: boolean;
  conflict: boolean;
}

export interface GitStatus {
  repoRoot: string;
  branch: string;
  /** Upstream tracking ref, e.g. "origin/main". */
  upstream?: string;
  ahead: number;
  behind: number;
  files: GitFileEntry[];
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  /** Line-change stats per work path, available without loading full diffs. */
  numstat: Record<string, GitNumstat>;
}

export interface GitNumstat {
  additions: number;
  deletions: number;
}

export interface GitDiffResult {
  path: string;
  diff: string;
  truncated: boolean;
}

export interface GitOperationResult {
  ok: boolean;
  message: string;
}

export interface GitCommitMessageResult {
  message: string;
  model: string;
}

export interface FileEntry {
  name: string;
  /** Absolute path. */
  path: string;
  type: "dir" | "file";
  size?: number;
}

export interface FileContentResult {
  content: string;
  truncated: boolean;
  binary: boolean;
}

/** Versioned read for the built-in editor (mtime + content hash snapshot). */
export interface EditableTextResult {
  content: string;
  mtimeMs: number;
  /** sha256 of the utf8 content, hex. */
  contentHash: string;
  sizeBytes: number;
  totalLines: number;
  binary: boolean;
}

/** Expected snapshot the writer must match (optimistic concurrency). */
export interface WriteTextExpected {
  mtimeMs?: number;
  contentHash?: string;
}

export interface WriteTextResult {
  mtimeMs: number;
  contentHash: string;
  totalLines: number;
  sizeBytes: number;
}

/** Base64-encoded file payload for previews (images / pdf / text). */
export interface WorkspaceBinaryResult {
  mimeType: string;
  data: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface MentionSearchEntry {
  /** Path relative to the workspace root. */
  path: string;
  name: string;
  kind: "dir" | "file";
}

export interface MentionSearchResult {
  entries: MentionSearchEntry[];
  truncated: boolean;
}

/** Fs bridge error codes surfaced to the renderer (see lib/fsErrors). */
export type FsErrorCode =
  | "STALE_FILE"
  | "TOO_LARGE"
  | "BINARY"
  | "NOT_FOUND"
  | "OUTSIDE_WORKSPACE";

/** Debounced fs change batch pushed from the main process. */
export interface WorkspaceChangedEvent {
  cwd: string;
  /** Paths relative to cwd; [""] means an unknown/root-level change. */
  paths: string[];
}

export type ModelLoginEvent =
  | {
      type: "prompt";
      promptId: string;
      promptType: "text" | "secret" | "select" | "manual_code";
      message: string;
      placeholder?: string;
      options?: Array<{ id: string; label: string; description?: string }>;
    }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      expiresInSeconds?: number;
    }
  | { type: "info"; message: string }
  | { type: "progress"; message: string }
  | { type: "complete"; providerId: string }
  | { type: "cancelled" }
  | { type: "error"; message: string };

/** Thinking levels pi accepts via `--thinking`. Empty string means "not set". */
export type AgentThinkingLevel = "" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Pi Agent settings applied to sessions launched by E-Pi. The two prompt
 * fields map to `--system-prompt` (replace the default prompt) and
 * `--append-system-prompt` (append to it). Both are optional and can be set
 * at the same time: the replacement becomes the base prompt, then the append
 * text is added after it. These only affect E-Pi-launched sessions, never
 * global `~/.pi` files.
 */
export interface PiAgentConfig {
  /** Replaces pi's default system prompt when non-empty (--system-prompt). */
  systemPrompt: string;
  /** Appended after the system prompt when non-empty (--append-system-prompt). */
  appendSystemPrompt: string;
  /** Default thinking level for new sessions; empty = let pi decide. */
  thinkingLevel: AgentThinkingLevel;
  /** Load AGENTS.md / CLAUDE.md context files (false => --no-context-files). */
  contextFiles: boolean;
}

export interface AgentConfigSaveRequest {
  config: PiAgentConfig;
}

/**
 * Pi TUI settings, read from / merged into pi's own `~/.pi/agent/settings.json`
 * (honoring `PI_CODING_AGENT_DIR`). Unlike `PiAgentConfig` — which is stored by
 * E-Pi and passed as CLI args — these are plain pi settings consumed by the
 * interactive TUI that runs inside E-Pi's terminal. Changes apply to sessions
 * started after the save; running sessions keep their current values.
 */
export interface PiTuiSettings {
  /** Hide the startup header (pi `quietStartup`). */
  quietStartup: boolean;
  /** Hide thinking blocks in the transcript (pi `hideThinkingBlock`). */
  hideThinkingBlock: boolean;
}

export interface PiTuiSettingsSaveRequest {
  settings: PiTuiSettings;
}

export interface EPiApi {
  app: {
    getInfo(): Promise<AppInfo>;
    /** Persist the default folder for new sessions; resolves with the refreshed app info. */
    setDefaultCwd(cwd: string): Promise<AppInfo>;
    /** Check the npm registry for a newer pi release. */
    checkPiUpdate(): Promise<PiUpdateInfo>;
    /**
     * Apply a pi update in place: download the tarball, install it next to the
     * bundled package and atomically swap it in, then restart every live
     * session so they run the new version. Resolves with the result of the
     * update (the previous version and the newly installed one).
     */
    applyPiUpdate(): Promise<PiUpdateResult>;
    chooseDirectory(defaultPath?: string): Promise<string | undefined>;
    /** Pick one or more folders (multi-repo projects). */
    chooseDirectories(defaultPath?: string): Promise<string[]>;
    chooseFiles(): Promise<string[]>;
    getPathForFile(file: File): string;
    pasteImage(): Promise<string | null>;
    imageData(filePath: string, maxSize?: number): Promise<string | null>;
    openPath(path: string): Promise<void>;
    /** Reveal the item in Finder (macOS) / Explorer (Windows) / file manager (Linux). */
    showInFolder(path: string): Promise<void>;
    /** Open a file with a specific app bundle (macOS). */
    openWith(appPath: string, filePath: string): Promise<void>;
    /** Native macOS "choose an application" dialog; undefined when cancelled. */
    chooseApp(): Promise<string | undefined>;
    /** Apps scanned from the system that can be used to open files ([] on non-macOS). */
    listApps(): Promise<AppDescriptor[]>;
    /** Apps declared to open the given file extension (fallback: dev apps). */
    appsForExtension(extension: string): Promise<AppDescriptor[]>;
    /** Persist the default "open with" app; undefined restores the system default. */
    setOpenWithApp(appPath: string | undefined): Promise<AppInfo>;
    copyText(text: string): Promise<void>;
    /** Keep native chrome (titlebar, scrollbars) in step with the app theme. */
    setTheme(theme: "light" | "dark"): Promise<void>;
    log(message: string): void;
  };
  sessions: {
    list(): Promise<SessionSummary[]>;
    create(request: CreateSessionRequest): Promise<SessionSummary>;
    rename(request: RenameSessionRequest): Promise<void>;
    remove(path: string): Promise<void>;
    /** Push an up-to-date session list whenever a session file changes on disk (e.g. the first message lands). */
    onUpdated(listener: (sessions: SessionSummary[]) => void): () => void;
  };
  projects: {
    list(): Promise<Project[]>;
    create(request: CreateProjectRequest): Promise<Project[]>;
    update(request: UpdateProjectRequest): Promise<Project[]>;
    remove(id: string): Promise<Project[]>;
    /** Resolve the project owning a cwd (undefined for implicit single-folder projects). */
    resolve(cwd: string): Promise<Project | undefined>;
    /** Folders of a project that contain a .git directory (for the review repo switcher). */
    gitRepos(folders: string[]): Promise<string[]>;
    /** Push the project list whenever it changes on disk. */
    onUpdated(listener: (projects: Project[]) => void): () => void;
  };
  runtime: {
    getStates(): Promise<Record<string, PiRuntimeState>>;
    /** Ensure the session's pi process is running; does not stop other sessions. */
    start(sessionPath: string): Promise<void>;
    /** Stop one session's process, or all sessions when omitted. */
    stop(sessionPath?: string): Promise<void>;
    write(sessionPath: string, data: string): void;
    submit(sessionPath: string, text: string): Promise<void>;
    interrupt(sessionPath: string): void;
    resize(sessionPath: string, size: ResizeTerminalRequest): void;
    /** Subscribe to output of every session. */
    onAnyData(listener: (sessionPath: string, data: string) => void): () => void;
    onState(listener: (state: PiRuntimeState) => void): () => void;
  };
  packages: {
    list(cwd: string): Promise<PackageRecord[]>;
    /** Check the registry/remotes for available updates; cached briefly in the main process. */
    checkUpdates(cwd: string, force?: boolean): Promise<PackageUpdateInfo[]>;
    /** Search the npm registry for Pi packages (`keywords:pi-package` filtered). */
    search(query: string): Promise<RemotePackageInfo[]>;
    /** Npm download stats for the last month; cached briefly in the main process. */
    downloads(name: string): Promise<PackageDownloads>;
    install(request: PackageMutation): Promise<PackageRecord[]>;
    remove(request: PackageMutation): Promise<PackageRecord[]>;
    update(request: PackageUpdateRequest): Promise<PackageRecord[]>;
    onProgress(listener: (progress: PackageProgress) => void): () => void;
  };
  models: {
    list(): Promise<ModelManagementState>;
    login(request: ModelLoginRequest): Promise<ModelManagementState>;
    respondToLogin(response: ModelLoginResponse): void;
    cancelLogin(): void;
    logout(providerId: string): Promise<ModelManagementState>;
    setDefault(request: SetDefaultModelRequest): Promise<ModelManagementState>;
    customList(): Promise<CustomProviderConfig[]>;
    customSave(request: CustomProviderRequest): Promise<CustomProviderConfig[]>;
    customRemove(request: CustomProviderRemoveRequest): Promise<CustomProviderConfig[]>;
    /** Fetch the model list from an OpenAI-compatible /models endpoint. */
    fetchModels(request: FetchModelsRequest): Promise<CustomModelDefinition[]>;
    /** Look up models.dev metadata for a set of model ids (best-effort, empty on failure). */
    catalogMeta(request: CatalogMetaRequest): Promise<Record<string, ModelCatalogMeta>>;
    onLoginEvent(listener: (event: ModelLoginEvent) => void): () => void;
  };
  notifications: {
    /** A task-completion banner was clicked; activate the given session. */
    onOpenSession(listener: (sessionPath: string) => void): () => void;
  };
  agent: {
    getConfig(): Promise<PiAgentConfig>;
    /** Persist the config and restart every live session so it takes effect. */
    saveConfig(request: AgentConfigSaveRequest): Promise<PiAgentConfig>;
    /** Read pi TUI settings from pi's own settings.json. */
    getTuiSettings(): Promise<PiTuiSettings>;
    /**
     * Merge pi TUI settings into pi's own settings.json, preserving every
     * other key. Takes effect for sessions started after the save.
     */
    saveTuiSettings(request: PiTuiSettingsSaveRequest): Promise<PiTuiSettings>;
  };
  commands: {
    /** Slash commands available in the composer: pi built-ins + prompt templates. */
    list(cwd: string): Promise<CommandRecord[]>;
    /**
     * Argument completions for a slash command's argument (pi's
     * `getArgumentCompletions`). Returns null when the command has no
     * argument suggestions.
     */
    argumentCompletions(cwd: string, command: string, argumentPrefix: string): Promise<CommandArgumentOption[] | null>;
  };
  skills: {
    list(cwd: string): Promise<SkillRecord[]>;
    read(cwd: string, filePath: string): Promise<string>;
    create(request: SkillCreateRequest): Promise<SkillRecord[]>;
    addPath(request: SkillAddPathRequest): Promise<SkillRecord[]>;
    remove(request: SkillMutation): Promise<SkillRecord[]>;
    setEnabled(request: SkillSetEnabledRequest): Promise<SkillRecord[]>;
  };
  git: {
    status(cwd: string): Promise<GitStatus>;
    diff(cwd: string, path: string): Promise<GitDiffResult>;
    stage(cwd: string, paths: string[]): Promise<GitOperationResult>;
    unstage(cwd: string, paths: string[]): Promise<GitOperationResult>;
    generateMessage(cwd: string, stagedOnly: boolean): Promise<GitCommitMessageResult>;
    commit(cwd: string, message: string): Promise<GitOperationResult>;
    push(cwd: string): Promise<GitOperationResult>;
    pull(cwd: string): Promise<GitOperationResult>;
    /** Start watching the repo at `cwd` for status-affecting changes. */
    watchStart(cwd: string): Promise<void>;
    /** Stop the watcher if it is watching `cwd`. */
    watchStop(cwd: string): Promise<void>;
    /** Subscribe to watcher fires; returns an unsubscribe function. */
    onChanged(listener: (cwd: string) => void): () => void;
  };
  fs: {
    listDir(cwd: string, path: string): Promise<FileEntry[]>;
    readFile(cwd: string, path: string): Promise<FileContentResult>;
    /** Versioned text read for the built-in editor. */
    readEditableText(cwd: string, path: string): Promise<EditableTextResult>;
    /** Versioned write; rejects with code STALE_FILE when the snapshot mismatches. */
    writeText(
      cwd: string,
      path: string,
      content: string,
      expected?: WriteTextExpected,
    ): Promise<WriteTextResult>;
    /** Base64 payload for previews (images / pdf / text). */
    readWorkspaceBinary(cwd: string, path: string, maxBytes?: number): Promise<WorkspaceBinaryResult>;
    /** Substring search across the workspace (file tree search box). */
    mentionSearch(cwd: string, query: string, limit?: number): Promise<MentionSearchResult>;
  };
  workspace: {
    /** Start watching cwd for fs changes (idempotent per cwd). */
    watchStart(cwd: string): Promise<void>;
    /** Stop watching cwd. */
    watchStop(cwd: string): Promise<void>;
    /** Subscribe to debounced change batches; returns an unsubscribe function. */
    onChanged(listener: (event: WorkspaceChangedEvent) => void): () => void;
  };
  sideTerminal: {
    spawn(cwd: string): Promise<string>;
    write(id: string, data: string): void;
    resize(id: string, size: ResizeTerminalRequest): void;
    kill(id: string): void;
    onData(listener: (id: string, data: string) => void): () => void;
  };
}
