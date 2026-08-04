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
  sessionPath?: string;
  cwd?: string;
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

export interface EPiApi {
  app: {
    getInfo(): Promise<AppInfo>;
    chooseDirectory(defaultPath?: string): Promise<string | undefined>;
    openPath(path: string): Promise<void>;
  };
  sessions: {
    list(): Promise<SessionSummary[]>;
    create(request: CreateSessionRequest): Promise<SessionSummary>;
    rename(request: RenameSessionRequest): Promise<void>;
    remove(path: string): Promise<void>;
  };
  runtime: {
    getState(): Promise<PiRuntimeState>;
    start(sessionPath: string): Promise<void>;
    stop(): Promise<void>;
    write(data: string): void;
    submit(text: string): Promise<void>;
    interrupt(): void;
    resize(size: ResizeTerminalRequest): void;
    onData(listener: (data: string) => void): () => void;
    onState(listener: (state: PiRuntimeState) => void): () => void;
  };
  packages: {
    list(cwd: string): Promise<PackageRecord[]>;
    install(request: PackageMutation): Promise<PackageRecord[]>;
    remove(request: PackageMutation): Promise<PackageRecord[]>;
    update(request: PackageUpdateRequest): Promise<PackageRecord[]>;
    onProgress(listener: (progress: PackageProgress) => void): () => void;
  };
}
