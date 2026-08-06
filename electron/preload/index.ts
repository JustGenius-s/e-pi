import { contextBridge, ipcRenderer, webUtils } from "electron";

import type {
  AgentConfigSaveRequest,
  AppDescriptor,
  AppInfo,
  CommandRecord,
  CreateSessionRequest,
  CustomProviderConfig,
  CustomProviderRemoveRequest,
  CustomProviderRequest,
  EPiApi,
  FileContentResult,
  FileEntry,
  GitCommitMessageResult,
  GitDiffResult,
  GitOperationResult,
  GitStatus,
  ModelLoginEvent,
  ModelLoginRequest,
  ModelLoginResponse,
  ModelManagementState,
  PackageMutation,
  PackageDownloads,
  PackageProgress,
  PackageRecord,
  PackageUpdateInfo,
  PackageUpdateRequest,
  PiAgentConfig,
  PiUpdateInfo,
  PiRuntimeState,
  RemotePackageInfo,
  RenameSessionRequest,
  ResizeTerminalRequest,
  SetDefaultModelRequest,
  SessionSummary,
  SkillAddPathRequest,
  SkillCreateRequest,
  SkillMutation,
  SkillRecord,
  SkillSetEnabledRequest,
} from "../../src/types/contracts";

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: EPiApi = {
  app: {
    getInfo: () => ipcRenderer.invoke("app:get-info") as Promise<AppInfo>,
    setDefaultCwd: (cwd: string) => ipcRenderer.invoke("app:set-default-cwd", cwd) as Promise<AppInfo>,
    checkPiUpdate: () => ipcRenderer.invoke("app:check-pi-update") as Promise<PiUpdateInfo>,
    chooseDirectory: (defaultPath?: string) =>
      ipcRenderer.invoke("app:choose-directory", defaultPath) as Promise<string | undefined>,
    chooseFiles: () => ipcRenderer.invoke("app:choose-files") as Promise<string[]>,
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
    pasteImage: () => ipcRenderer.invoke("app:paste-image") as Promise<string | null>,
    imageData: (filePath: string, maxSize?: number) =>
      ipcRenderer.invoke("app:image-data", filePath, maxSize) as Promise<string | null>,
    openPath: (path: string) => ipcRenderer.invoke("app:open-path", path) as Promise<void>,
    /** Reveal the item in Finder (macOS) / Explorer (Windows) / file manager (Linux). */
    showInFolder: (path: string) => ipcRenderer.invoke("app:show-in-folder", path) as Promise<void>,
    openWith: (appPath: string, filePath: string) =>
      ipcRenderer.invoke("app:open-with", appPath, filePath) as Promise<void>,
    /** Native macOS "choose an application" dialog; undefined when cancelled. */
    chooseApp: () => ipcRenderer.invoke("app:choose-app") as Promise<string | undefined>,
    listApps: () => ipcRenderer.invoke("apps:list") as Promise<AppDescriptor[]>,
    appsForExtension: (extension: string) =>
      ipcRenderer.invoke("apps:for-extension", extension) as Promise<AppDescriptor[]>,
    setOpenWithApp: (appPath: string | undefined) =>
      ipcRenderer.invoke("app:set-open-with-app", appPath) as Promise<AppInfo>,
    copyText: (text: string) => ipcRenderer.invoke("app:copy-text", text) as Promise<void>,
    setTheme: (theme: "light" | "dark") => ipcRenderer.invoke("app:set-theme", theme) as Promise<void>,
    log: (message: string) => ipcRenderer.send("app:log", message),
  },
  sessions: {
    list: () => ipcRenderer.invoke("sessions:list") as Promise<SessionSummary[]>,
    create: (request: CreateSessionRequest) =>
      ipcRenderer.invoke("sessions:create", request) as Promise<SessionSummary>,
    rename: (request: RenameSessionRequest) => ipcRenderer.invoke("sessions:rename", request) as Promise<void>,
    remove: (path: string) => ipcRenderer.invoke("sessions:remove", path) as Promise<void>,
  },
  runtime: {
    getStates: () => ipcRenderer.invoke("runtime:get-states") as Promise<Record<string, PiRuntimeState>>,
    start: (sessionPath: string) => ipcRenderer.invoke("runtime:start", sessionPath) as Promise<void>,
    stop: (sessionPath?: string) => ipcRenderer.invoke("runtime:stop", sessionPath) as Promise<void>,
    write: (sessionPath: string, data: string) => ipcRenderer.send("runtime:write", sessionPath, data),
    submit: (sessionPath: string, text: string) =>
      ipcRenderer.invoke("runtime:submit", sessionPath, text) as Promise<void>,
    interrupt: (sessionPath: string) => ipcRenderer.send("runtime:interrupt", sessionPath),
    resize: (sessionPath: string, size: ResizeTerminalRequest) => ipcRenderer.send("runtime:resize", sessionPath, size),
    onAnyData: (listener: (sessionPath: string, data: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: { sessionPath: string; data: string }) =>
        listener(payload.sessionPath, payload.data);
      ipcRenderer.on("runtime:data", handler);
      return () => ipcRenderer.removeListener("runtime:data", handler);
    },
    onState: (listener: (state: PiRuntimeState) => void) => subscribe("runtime:state", listener),
  },
  packages: {
    list: (cwd: string) => ipcRenderer.invoke("packages:list", cwd) as Promise<PackageRecord[]>,
    checkUpdates: (cwd: string, force?: boolean) =>
      ipcRenderer.invoke("packages:check-updates", cwd, force) as Promise<PackageUpdateInfo[]>,
    search: (query: string) => ipcRenderer.invoke("packages:search", query) as Promise<RemotePackageInfo[]>,
    downloads: (name: string) => ipcRenderer.invoke("packages:downloads", name) as Promise<PackageDownloads>,
    install: (request: PackageMutation) => ipcRenderer.invoke("packages:install", request) as Promise<PackageRecord[]>,
    remove: (request: PackageMutation) => ipcRenderer.invoke("packages:remove", request) as Promise<PackageRecord[]>,
    update: (request: PackageUpdateRequest) =>
      ipcRenderer.invoke("packages:update", request) as Promise<PackageRecord[]>,
    onProgress: (listener: (progress: PackageProgress) => void) => subscribe("packages:progress", listener),
  },
  models: {
    list: () => ipcRenderer.invoke("models:list") as Promise<ModelManagementState>,
    login: (request: ModelLoginRequest) => ipcRenderer.invoke("models:login", request) as Promise<ModelManagementState>,
    respondToLogin: (response: ModelLoginResponse) => ipcRenderer.send("models:login-response", response),
    cancelLogin: () => ipcRenderer.send("models:cancel-login"),
    logout: (providerId: string) => ipcRenderer.invoke("models:logout", providerId) as Promise<ModelManagementState>,
    setDefault: (request: SetDefaultModelRequest) =>
      ipcRenderer.invoke("models:set-default", request) as Promise<ModelManagementState>,
    customList: () => ipcRenderer.invoke("models:custom-list") as Promise<CustomProviderConfig[]>,
    customSave: (request: CustomProviderRequest) =>
      ipcRenderer.invoke("models:custom-save", request) as Promise<CustomProviderConfig[]>,
    customRemove: (request: CustomProviderRemoveRequest) =>
      ipcRenderer.invoke("models:custom-remove", request) as Promise<CustomProviderConfig[]>,
    onLoginEvent: (listener: (event: ModelLoginEvent) => void) => subscribe("models:login-event", listener),
  },
  agent: {
    getConfig: () => ipcRenderer.invoke("agent:get-config") as Promise<PiAgentConfig>,
    saveConfig: (request: AgentConfigSaveRequest) =>
      ipcRenderer.invoke("agent:save-config", request) as Promise<PiAgentConfig>,
  },
  commands: {
    list: (cwd: string) => ipcRenderer.invoke("commands:list", cwd) as Promise<CommandRecord[]>,
  },
  skills: {
    list: (cwd: string) => ipcRenderer.invoke("skills:list", cwd) as Promise<SkillRecord[]>,
    read: (cwd: string, filePath: string) => ipcRenderer.invoke("skills:read", cwd, filePath) as Promise<string>,
    create: (request: SkillCreateRequest) => ipcRenderer.invoke("skills:create", request) as Promise<SkillRecord[]>,
    addPath: (request: SkillAddPathRequest) => ipcRenderer.invoke("skills:add-path", request) as Promise<SkillRecord[]>,
    remove: (request: SkillMutation) => ipcRenderer.invoke("skills:remove", request) as Promise<SkillRecord[]>,
    setEnabled: (request: SkillSetEnabledRequest) =>
      ipcRenderer.invoke("skills:set-enabled", request) as Promise<SkillRecord[]>,
  },
  git: {
    status: (cwd: string) => ipcRenderer.invoke("git:status", cwd) as Promise<GitStatus>,
    diff: (cwd: string, path: string) => ipcRenderer.invoke("git:diff", cwd, path) as Promise<GitDiffResult>,
    stage: (cwd: string, paths: string[]) => ipcRenderer.invoke("git:stage", cwd, paths) as Promise<GitOperationResult>,
    unstage: (cwd: string, paths: string[]) =>
      ipcRenderer.invoke("git:unstage", cwd, paths) as Promise<GitOperationResult>,
    generateMessage: (cwd: string, stagedOnly: boolean) =>
      ipcRenderer.invoke("git:generate-message", cwd, stagedOnly) as Promise<GitCommitMessageResult>,
    commit: (cwd: string, message: string) =>
      ipcRenderer.invoke("git:commit", cwd, message) as Promise<GitOperationResult>,
    push: (cwd: string) => ipcRenderer.invoke("git:push", cwd) as Promise<GitOperationResult>,
    pull: (cwd: string) => ipcRenderer.invoke("git:pull", cwd) as Promise<GitOperationResult>,
    watchStart: (cwd: string) => ipcRenderer.invoke("git:watch-start", cwd) as Promise<void>,
    watchStop: (cwd: string) => ipcRenderer.invoke("git:watch-stop", cwd) as Promise<void>,
    onChanged: (listener: (cwd: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, cwd: string): void => listener(cwd);
      ipcRenderer.on("git:changed", handler);
      return () => ipcRenderer.removeListener("git:changed", handler);
    },
  },
  fs: {
    listDir: (cwd: string, path: string) => ipcRenderer.invoke("fs:list-dir", cwd, path) as Promise<FileEntry[]>,
    readFile: (cwd: string, path: string) =>
      ipcRenderer.invoke("fs:read-file", cwd, path) as Promise<FileContentResult>,
  },
  sideTerminal: {
    spawn: (cwd: string) => ipcRenderer.invoke("side-terminal:spawn", cwd) as Promise<string>,
    write: (id: string, data: string) => ipcRenderer.send("side-terminal:write", id, data),
    resize: (id: string, size: ResizeTerminalRequest) => ipcRenderer.send("side-terminal:resize", id, size),
    kill: (id: string) => ipcRenderer.send("side-terminal:kill", id),
    onData: (listener: (id: string, data: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: { id: string; data: string }): void =>
        listener(payload.id, payload.data);
      ipcRenderer.on("side-terminal:data", handler);
      return () => ipcRenderer.removeListener("side-terminal:data", handler);
    },
  },
};

contextBridge.exposeInMainWorld("ePi", api);
