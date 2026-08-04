import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AppInfo,
  CreateSessionRequest,
  CustomProviderConfig,
  CustomProviderRemoveRequest,
  CustomProviderRequest,
  ModelLoginEvent,
  ModelLoginRequest,
  ModelLoginResponse,
  ModelManagementState,
  PackageMutation,
  PackageProgress,
  PackageRecord,
  PackageUpdateRequest,
  EPiApi,
  PiRuntimeState,
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
    chooseDirectory: (defaultPath?: string) =>
      ipcRenderer.invoke("app:choose-directory", defaultPath) as Promise<string | undefined>,
    chooseFiles: (options?: { imagesOnly?: boolean }) =>
      ipcRenderer.invoke("app:choose-files", options) as Promise<string[]>,
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
    openPath: (path: string) => ipcRenderer.invoke("app:open-path", path) as Promise<void>,
  },
  sessions: {
    list: () => ipcRenderer.invoke("sessions:list") as Promise<SessionSummary[]>,
    create: (request: CreateSessionRequest) =>
      ipcRenderer.invoke("sessions:create", request) as Promise<SessionSummary>,
    rename: (request: RenameSessionRequest) =>
      ipcRenderer.invoke("sessions:rename", request) as Promise<void>,
    remove: (path: string) => ipcRenderer.invoke("sessions:remove", path) as Promise<void>,
  },
  runtime: {
    getState: () => ipcRenderer.invoke("runtime:get-state") as Promise<PiRuntimeState>,
    start: (sessionPath: string) =>
      ipcRenderer.invoke("runtime:start", sessionPath) as Promise<void>,
    stop: () => ipcRenderer.invoke("runtime:stop") as Promise<void>,
    write: (data: string) => ipcRenderer.send("runtime:write", data),
    submit: (text: string) => ipcRenderer.invoke("runtime:submit", text) as Promise<void>,
    interrupt: () => ipcRenderer.send("runtime:interrupt"),
    resize: (size: ResizeTerminalRequest) => ipcRenderer.send("runtime:resize", size),
    onData: (listener: (data: string) => void) => subscribe("runtime:data", listener),
    onState: (listener: (state: PiRuntimeState) => void) => subscribe("runtime:state", listener),
  },
  packages: {
    list: (cwd: string) => ipcRenderer.invoke("packages:list", cwd) as Promise<PackageRecord[]>,
    install: (request: PackageMutation) =>
      ipcRenderer.invoke("packages:install", request) as Promise<PackageRecord[]>,
    remove: (request: PackageMutation) =>
      ipcRenderer.invoke("packages:remove", request) as Promise<PackageRecord[]>,
    update: (request: PackageUpdateRequest) =>
      ipcRenderer.invoke("packages:update", request) as Promise<PackageRecord[]>,
    onProgress: (listener: (progress: PackageProgress) => void) =>
      subscribe("packages:progress", listener),
  },
  models: {
    list: () => ipcRenderer.invoke("models:list") as Promise<ModelManagementState>,
    login: (request: ModelLoginRequest) =>
      ipcRenderer.invoke("models:login", request) as Promise<ModelManagementState>,
    respondToLogin: (response: ModelLoginResponse) =>
      ipcRenderer.send("models:login-response", response),
    cancelLogin: () => ipcRenderer.send("models:cancel-login"),
    logout: (providerId: string) =>
      ipcRenderer.invoke("models:logout", providerId) as Promise<ModelManagementState>,
    setDefault: (request: SetDefaultModelRequest) =>
      ipcRenderer.invoke("models:set-default", request) as Promise<ModelManagementState>,
    customList: () => ipcRenderer.invoke("models:custom-list") as Promise<CustomProviderConfig[]>,
    customSave: (request: CustomProviderRequest) =>
      ipcRenderer.invoke("models:custom-save", request) as Promise<CustomProviderConfig[]>,
    customRemove: (request: CustomProviderRemoveRequest) =>
      ipcRenderer.invoke("models:custom-remove", request) as Promise<CustomProviderConfig[]>,
    onLoginEvent: (listener: (event: ModelLoginEvent) => void) =>
      subscribe("models:login-event", listener),
  },
  skills: {
    list: (cwd: string) => ipcRenderer.invoke("skills:list", cwd) as Promise<SkillRecord[]>,
    read: (cwd: string, filePath: string) =>
      ipcRenderer.invoke("skills:read", cwd, filePath) as Promise<string>,
    create: (request: SkillCreateRequest) =>
      ipcRenderer.invoke("skills:create", request) as Promise<SkillRecord[]>,
    addPath: (request: SkillAddPathRequest) =>
      ipcRenderer.invoke("skills:add-path", request) as Promise<SkillRecord[]>,
    remove: (request: SkillMutation) =>
      ipcRenderer.invoke("skills:remove", request) as Promise<SkillRecord[]>,
    setEnabled: (request: SkillSetEnabledRequest) =>
      ipcRenderer.invoke("skills:set-enabled", request) as Promise<SkillRecord[]>,
  },
};

contextBridge.exposeInMainWorld("ePi", api);
