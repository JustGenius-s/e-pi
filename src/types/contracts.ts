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
  /** Context usage of the active model; reported while the process is running. */
  context?: ContextUsageState;
  /** Cumulative token usage for this session; reported while the process is running. */
  usage?: SessionUsageState;
  /** Cache hit rate (0-100) of the latest assistant response; undefined before the first one. */
  cacheHitRate?: number;
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
  scope: "user" | "project";
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
}

export interface CustomProviderConfig {
  id: string;
  name?: string;
  baseUrl: string;
  api: string;
  apiKey?: string;
  models: CustomModelDefinition[];
}

export interface CustomProviderRequest {
  provider: CustomProviderConfig;
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

export interface EPiApi {
  app: {
    getInfo(): Promise<AppInfo>;
    chooseDirectory(defaultPath?: string): Promise<string | undefined>;
    chooseFiles(): Promise<string[]>;
    getPathForFile(file: File): string;
    pasteImage(): Promise<string | null>;
    imageData(filePath: string, maxSize?: number): Promise<string | null>;
    openPath(path: string): Promise<void>;
    copyText(text: string): Promise<void>;
    log(message: string): void;
  };
  sessions: {
    list(): Promise<SessionSummary[]>;
    create(request: CreateSessionRequest): Promise<SessionSummary>;
    rename(request: RenameSessionRequest): Promise<void>;
    remove(path: string): Promise<void>;
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
    onLoginEvent(listener: (event: ModelLoginEvent) => void): () => void;
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
  };
  fs: {
    listDir(cwd: string, path: string): Promise<FileEntry[]>;
    readFile(cwd: string, path: string): Promise<FileContentResult>;
  };
  sideTerminal: {
    spawn(cwd: string): Promise<string>;
    write(id: string, data: string): void;
    resize(id: string, size: ResizeTerminalRequest): void;
    kill(id: string): void;
    onData(listener: (id: string, data: string) => void): () => void;
  };
}
