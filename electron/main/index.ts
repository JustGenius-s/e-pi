import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { PackageService } from "./services/package-service";
import { PiRuntime } from "./services/pi-runtime";
import { SessionService } from "./services/session-service";
import type {
  CreateSessionRequest,
  PackageMutation,
  PackageUpdateRequest,
  ResizeTerminalRequest,
} from "../../src/types/contracts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const runtime = new PiRuntime();
const sessions = new SessionService();
const packages = new PackageService();
let mainWindow: BrowserWindow | undefined;

function sendToRenderer(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function activeCwd(): string {
  return runtime.state.cwd ?? app.getPath("home");
}

function registerHandlers(): void {
  ipcMain.handle("app:get-info", () => ({
    platform: process.platform,
    arch: process.arch,
    appVersion: app.getVersion(),
    piVersion: PI_VERSION,
    defaultCwd: app.getPath("home"),
  }));

  ipcMain.handle("app:choose-directory", async (_event, defaultPath?: string) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      defaultPath: defaultPath || activeCwd(),
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? undefined : result.filePaths[0];
  });

  ipcMain.handle("app:open-path", async (_event, path: string) => {
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });

  ipcMain.handle("sessions:list", () => sessions.list());
  ipcMain.handle("sessions:create", async (_event, request: CreateSessionRequest) => {
    return sessions.create(request.cwd?.trim() || activeCwd());
  });
  ipcMain.handle("sessions:rename", async (_event, request: { path: string; name: string }) => {
    const wasActive = runtime.state.sessionPath === request.path;
    if (wasActive) await runtime.stop();
    try {
      sessions.rename(request.path, request.name);
    } finally {
      if (wasActive) await runtime.start(request.path, sessions.getCwd(request.path));
    }
  });
  ipcMain.handle("sessions:remove", async (_event, path: string) => {
    const wasActive = runtime.state.sessionPath === path;
    if (wasActive) await runtime.stop();
    await shell.trashItem(path);
  });

  ipcMain.handle("runtime:get-state", () => runtime.state);
  ipcMain.handle("runtime:start", async (_event, path: string) => runtime.start(path, sessions.getCwd(path)));
  ipcMain.handle("runtime:stop", () => runtime.stop());
  ipcMain.on("runtime:write", (_event, data: string) => runtime.write(data));
  ipcMain.handle("runtime:submit", (_event, text: string) => runtime.submit(text));
  ipcMain.on("runtime:interrupt", () => runtime.interrupt());
  ipcMain.on("runtime:resize", (_event, size: ResizeTerminalRequest) => runtime.resize(size));

  ipcMain.handle("packages:list", (_event, cwd: string) => packages.list(cwd || activeCwd()));
  ipcMain.handle("packages:install", (_event, request: PackageMutation) => packages.install(request));
  ipcMain.handle("packages:remove", (_event, request: PackageMutation) => packages.remove(request));
  ipcMain.handle("packages:update", (_event, request: PackageUpdateRequest) => packages.update(request));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 620,
    title: "E-Pi",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#000000",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (!app.isPackaged) {
    mainWindow.webContents.on("console-message", (event) => {
      console.error(`[renderer:${event.level}] ${event.message}`);
    });
    mainWindow.webContents.on("did-finish-load", () => {
      void mainWindow?.webContents
        .executeJavaScript(`({
          url: location.href,
          readyState: document.readyState,
          rootChildren: document.getElementById("root")?.childElementCount,
          api: typeof window.ePi,
          scripts: [...document.scripts].map((script) => script.src || "inline")
        })`)
        .then((result) => console.error("[renderer:diagnostic]", result));
    });
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
}

runtime.onData((data) => sendToRenderer("runtime:data", data));
runtime.onState((state) => sendToRenderer("runtime:state", state));
packages.setProgressListener((progress) => sendToRenderer("packages:progress", progress));

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    registerHandlers();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("before-quit", () => {
    void runtime.stop();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
