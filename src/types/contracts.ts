export type PiProcessStatus = "idle" | "starting" | "running" | "stopping" | "exited" | "error";

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
  defaultModel?: {
    provider: string;
    id: string;
  };
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

export interface SetDefaultModelRequest {
  provider: string;
  id: string;
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
}
