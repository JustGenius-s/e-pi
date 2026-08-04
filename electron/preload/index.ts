import { contextBridge, ipcRenderer } from "electron";
import type {
  AppInfo,
  CreateSessionRequest,
  PackageMutation,
  PackageProgress,
  PackageRecord,
  PackageUpdateRequest,
  EPiApi,
  PiRuntimeState,
  RenameSessionRequest,
  ResizeTerminalRequest,
  SessionSummary,
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
    openPath: (path: string) => ipcRenderer.invoke("app:open-path", path) as Promise<void>,
  },
  sessions: {
    list: () => ipcRenderer.invoke("sessions:list") as Promise<SessionSummary[]>,
    create: (request: CreateSessionRequest) =>
      ipcRenderer.invoke("sessions:create", request) as Promise<SessionSummary>,
    rename: (request: RenameSessionRequest) => ipcRenderer.invoke("sessions:rename", request) as Promise<void>,
    remove: (path: string) => ipcRenderer.invoke("sessions:remove", path) as Promise<void>,
  },
  runtime: {
    getState: () => ipcRenderer.invoke("runtime:get-state") as Promise<PiRuntimeState>,
    start: (sessionPath: string) => ipcRenderer.invoke("runtime:start", sessionPath) as Promise<void>,
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
    onProgress: (listener: (progress: PackageProgress) => void) => subscribe("packages:progress", listener),
  },
};

contextBridge.exposeInMainWorld("ePi", api);
