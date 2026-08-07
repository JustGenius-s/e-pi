import { randomUUID } from "node:crypto";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, nativeTheme, shell } from "electron";

import type {
  AgentConfigSaveRequest,
  CreateProjectRequest,
  CreateSessionRequest,
  CustomProviderRemoveRequest,
  CustomProviderRequest,
  CatalogMetaRequest,
  FetchModelsRequest,
  ModelLoginRequest,
  ModelLoginResponse,
  PackageMutation,
  PackageUpdateRequest,
  ResizeTerminalRequest,
  SetDefaultModelRequest,
  SkillAddPathRequest,
  SkillCreateRequest,
  SkillMutation,
  SkillSetEnabledRequest,
  UpdateProjectRequest,
} from "../../src/types/contracts";
import { ensureNpmOnPath } from "./npm-path";
import { getAgentConfig, saveAgentConfig } from "./services/agent-config-service";
import { appsForExtension, chooseAppFromSystem, listDevApps, openWithApp } from "./services/app-launch-service";
import { getAppSettings, resolveDefaultCwd, setDefaultCwd, setOpenWithApp } from "./services/app-settings-service";
import { CommandService } from "./services/command-service";
import { debugLog, resetDebugLog } from "./services/debug-log";
import { FileService } from "./services/file-service";
import { GitService } from "./services/git-service";
import { ModelService } from "./services/model-service";
import { TaskNotificationService } from "./services/notification-service";
import { PackageService } from "./services/package-service";
import { PiRuntime } from "./services/pi-runtime";
import { applyPiUpdate, checkPiUpdate, readInstalledPiVersion } from "./services/pi-update-service";
import { ProjectService } from "./services/project-service";
import { SessionService } from "./services/session-service";
import { SideTerminalService } from "./services/side-terminal-service";
import { SkillService } from "./services/skill-service";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
// Required for native notifications on Windows (toast activation identity;
// must match the electron-builder appId).
app.setAppUserModelId("works.earendil.e-pi");
const runtime = new PiRuntime();
const sessions = new SessionService();
const projects = new ProjectService();
const packages = new PackageService();
const models = new ModelService();
const skills = new SkillService();
const commands = new CommandService();
const git = new GitService();
const fileService = new FileService();
const sideTerminals = new SideTerminalService();
let mainWindow: BrowserWindow | undefined;

function sendToRenderer(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}
function activeCwd(): string {
  const activePath = runtime.activeSessionPath;
  const state = activePath ? runtime.getStates()[activePath] : undefined;
  return state?.cwd ?? app.getPath("home");
}

async function cleanupStalePastedImages(): Promise<void> {
  const tempDir = app.getPath("temp");
  const files = await readdir(tempDir);
  await Promise.all(
    files
      .filter((name) => name.startsWith("e-pi-paste-") && name.endsWith(".png"))
      .map((name) => rm(join(tempDir, name), { force: true })),
  );
}

async function reloadActiveRuntime(): Promise<void> {
  // Auth/config changed: restart every live session so all processes pick up
  // the new providers, models, and credentials.
  await runtime.reloadAll();
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

function isImage(path: string): boolean {
  return extname(path).toLowerCase() in IMAGE_MIME;
}

function registerHandlers(): void {
  ipcMain.handle("app:get-info", async () => {
    const settings = await getAppSettings();
    return {
      platform: process.platform,
      arch: process.arch,
      appVersion: app.getVersion(),
      // Always read from disk so an in-place pi update shows the new version.
      piVersion: readInstalledPiVersion(),
      defaultCwd: await resolveDefaultCwd(),
      homeDir: app.getPath("home"),
      openWithApp: settings.openWithApp,
    };
  });

  ipcMain.handle("app:set-default-cwd", async (_event, cwd: string) => {
    await setDefaultCwd(cwd);
    const settings = await getAppSettings();
    return {
      platform: process.platform,
      arch: process.arch,
      appVersion: app.getVersion(),
      piVersion: readInstalledPiVersion(),
      defaultCwd: await resolveDefaultCwd(),
      openWithApp: settings.openWithApp,
    };
  });

  ipcMain.handle("app:set-open-with-app", async (_event, appPath: string | undefined) => {
    await setOpenWithApp(appPath || undefined);
    const settings = await getAppSettings();
    return {
      platform: process.platform,
      arch: process.arch,
      appVersion: app.getVersion(),
      piVersion: readInstalledPiVersion(),
      defaultCwd: await resolveDefaultCwd(),
      openWithApp: settings.openWithApp,
    };
  });

  // Development-oriented macOS apps for the file tree's "open with" menus.
  ipcMain.handle("apps:list", async () => (process.platform === "darwin" ? listDevApps() : []));

  // Apps declared to open the given file extension (fallback: dev apps).
  ipcMain.handle("apps:for-extension", async (_event, extension: string) =>
    process.platform === "darwin" ? appsForExtension(extension) : [],
  );

  // Open a file with a specific .app bundle (macOS).
  ipcMain.handle("app:open-with", async (_event, appPath: string, filePath: string) => {
    await openWithApp(appPath, filePath);
  });

  // Native macOS "choose an application" dialog; undefined when cancelled.
  ipcMain.handle("app:choose-app", async () => chooseAppFromSystem());

  ipcMain.handle("app:check-pi-update", () => checkPiUpdate());

  // Apply a pi update in place, then restart every live session so they run
  // the new version. Fails without touching the install when no update exists
  // or any step (download/extract/install/swap) errors. Session restarts are
  // best-effort: a restart failure must not report the update itself as failed.
  ipcMain.handle("app:apply-pi-update", async () => {
    const result = await applyPiUpdate();
    try {
      await runtime.reloadAll();
    } catch (reason) {
      debugLog("[pi-update] session restart failed", {
        message: reason instanceof Error ? reason.message : String(reason),
      });
    }
    return result;
  });

  // The renderer owns the theme choice (CSS variables + persistence); this
  // keeps native chrome (macOS traffic lights, scrollbars) in step with it.
  ipcMain.handle("app:set-theme", (_event, theme: "light" | "dark") => {
    nativeTheme.themeSource = theme === "dark" ? "dark" : "light";
  });

  ipcMain.handle("app:choose-directory", async (_event, defaultPath?: string) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      defaultPath: defaultPath || activeCwd(),
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? undefined : result.filePaths[0];
  });

  ipcMain.handle("app:choose-directories", async (_event, defaultPath?: string) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      defaultPath: defaultPath || activeCwd(),
      properties: ["openDirectory", "createDirectory", "multiSelections"],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle("app:choose-files", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      defaultPath: activeCwd(),
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "All files", extensions: ["*"] }],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle("app:open-path", async (_event, path: string) => {
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });

  // Reveal the item in Finder (macOS) / Explorer (Windows) / the file manager (Linux).
  ipcMain.handle("app:show-in-folder", (_event, path: string) => {
    shell.showItemInFolder(path);
  });

  ipcMain.handle("app:copy-text", (_event, text: string) => {
    clipboard.writeText(text);
  });

  ipcMain.on("app:log", (_event, message: string) => {
    debugLog("[renderer]", message);
  });

  ipcMain.handle("app:paste-image", async () => {
    // 1) The clipboard holds raw image pixels (screenshots, copying an image
    //    in a browser): persist them to a temp PNG.
    const image = clipboard.readImage();
    if (!image.isEmpty()) {
      const filePath = join(app.getPath("temp"), `e-pi-paste-${randomUUID()}.png`);
      await writeFile(filePath, image.toPNG());
      return filePath;
    }
    // 2) The clipboard holds a copied image FILE (Finder, WeCom, …): the
    //    pixels are empty but the file URL is available — attach the file
    //    directly instead of failing silently.
    const fileUrl = clipboard.read("public.file-url");
    if (fileUrl) {
      const path = fileURLToPath(fileUrl);
      if (isImage(path)) return path;
      return null;
    }
    // 3) Some apps copy plain "file://…" text instead of the typed pasteboard
    //    representation.
    const text = clipboard.readText();
    if (text.startsWith("file://")) {
      const path = fileURLToPath(text);
      if (isImage(path)) return path;
    }
    return null;
  });

  ipcMain.handle("app:image-data", async (_event, filePath: string, maxSize?: number) => {
    const mime = IMAGE_MIME[extname(filePath).toLowerCase()] ?? "image/png";
    if (maxSize && maxSize > 0) {
      const image = nativeImage.createFromPath(filePath);
      if (!image.isEmpty()) {
        const { width, height } = image.getSize();
        const scale = maxSize / Math.max(width, height);
        if (width > 0 && height > 0 && scale < 1) {
          return image
            .resize({
              width: Math.max(1, Math.round(width * scale)),
              height: Math.max(1, Math.round(height * scale)),
            })
            .toDataURL();
        }
        return image.toDataURL();
      }
    }
    const data = (await readFile(filePath)).toString("base64");
    return `data:${mime};base64,${data}`;
  });

  ipcMain.handle("sessions:list", () => sessions.list());
  ipcMain.handle("sessions:create", async (_event, request: CreateSessionRequest) => {
    return sessions.create(request.cwd?.trim() || activeCwd());
  });
  ipcMain.handle("projects:list", () => projects.list());
  ipcMain.handle("projects:create", (_event, request: CreateProjectRequest) => projects.create(request));
  ipcMain.handle("projects:update", (_event, request: UpdateProjectRequest) => projects.update(request));
  ipcMain.handle("projects:remove", (_event, id: string) => projects.remove(id));
  ipcMain.handle("projects:resolve", (_event, cwd: string) => projects.resolve(cwd));
  ipcMain.handle("projects:git-repos", (_event, folders: string[]) => projects.gitRepos(folders));
  ipcMain.handle("sessions:rename", async (_event, request: { path: string; name: string }) => {
    // Renaming appends a `session_info` entry to the session file — the file
    // itself is never moved. The running pi appends messages the same way
    // (atomic O_APPEND line writes), so no stop/restart is needed; stopping
    // would restart the pi process and replay the terminal for no reason.
    await sessions.rename(request.path, request.name);
  });
  ipcMain.handle("sessions:remove", async (_event, path: string) => {
    await runtime.stop(path);
    runtime.forget(path);
    await shell.trashItem(path);
  });

  ipcMain.handle("runtime:get-states", () => runtime.getStates());
  ipcMain.handle("runtime:start", async (_event, path: string) => {
    const cwd = await sessions.getCwd(path);
    debugLog("[ipc] runtime:start", { path, cwd });
    return runtime.start(path, cwd);
  });
  ipcMain.handle("runtime:stop", (_event, sessionPath?: string) => runtime.stop(sessionPath));
  ipcMain.on("runtime:write", (_event, sessionPath: string, data: string) => runtime.write(sessionPath, data));
  ipcMain.handle("runtime:submit", (_event, sessionPath: string, text: string) => {
    debugLog("[ipc] runtime:submit", { sessionPath, text: text.slice(0, 80) });
    return runtime.submit(sessionPath, text);
  });
  ipcMain.on("runtime:interrupt", (_event, sessionPath: string) => runtime.interrupt(sessionPath));
  ipcMain.on("runtime:resize", (_event, sessionPath: string, size: ResizeTerminalRequest) =>
    runtime.resize(sessionPath, size),
  );

  ipcMain.handle("packages:list", (_event, cwd: string) => packages.list(cwd || activeCwd()));
  ipcMain.handle("packages:check-updates", (_event, cwd: string, force?: boolean) =>
    packages.checkUpdates(cwd || activeCwd(), force),
  );
  ipcMain.handle("packages:search", (_event, query: string) => packages.searchRemote(query));
  ipcMain.handle("packages:downloads", (_event, name: string) => packages.downloads(name));
  ipcMain.handle("packages:install", (_event, request: PackageMutation) => packages.install(request));
  ipcMain.handle("packages:remove", (_event, request: PackageMutation) => packages.remove(request));
  ipcMain.handle("packages:update", (_event, request: PackageUpdateRequest) => packages.update(request));

  ipcMain.handle("commands:list", (_event, cwd: string) => commands.list(cwd || activeCwd()));

  ipcMain.handle("skills:list", (_event, cwd: string) => skills.list(cwd || activeCwd()));
  ipcMain.handle("skills:read", (_event, cwd: string, filePath: string) => skills.read(cwd || activeCwd(), filePath));
  ipcMain.handle("skills:create", async (_event, request: SkillCreateRequest) => skills.create(request));
  ipcMain.handle("skills:add-path", async (_event, request: SkillAddPathRequest) => skills.addPath(request));
  ipcMain.handle("skills:remove", async (_event, request: SkillMutation) => skills.remove(request));
  ipcMain.handle("skills:set-enabled", async (_event, request: SkillSetEnabledRequest) => skills.setEnabled(request));

  ipcMain.handle("git:status", async (_event, cwd: string) => {
    debugLog("[ipc] git:status", { cwd });
    return git.status(cwd || activeCwd());
  });
  ipcMain.handle("git:watch-start", (_event, cwd: string) => {
    const target = cwd || activeCwd();
    void git.watch(target, (changedCwd) => sendToRenderer("git:changed", changedCwd));
  });
  ipcMain.handle("git:watch-stop", (_event, cwd: string) => {
    git.unwatch(cwd || activeCwd());
  });
  ipcMain.handle("git:diff", async (_event, cwd: string, path: string) => git.diff(cwd || activeCwd(), path));
  ipcMain.handle("git:stage", async (_event, cwd: string, paths: string[]) => git.stage(cwd || activeCwd(), paths));
  ipcMain.handle("git:unstage", async (_event, cwd: string, paths: string[]) => git.unstage(cwd || activeCwd(), paths));
  ipcMain.handle("git:generate-message", async (_event, cwd: string, stagedOnly: boolean) => {
    debugLog("[ipc] git:generate-message", { cwd, stagedOnly });
    return git.generateMessage(cwd || activeCwd(), stagedOnly);
  });
  ipcMain.handle("git:commit", async (_event, cwd: string, message: string) => {
    debugLog("[ipc] git:commit", { cwd, subject: message.split("\n")[0] });
    return git.commit(cwd || activeCwd(), message);
  });
  ipcMain.handle("git:push", async (_event, cwd: string) => {
    debugLog("[ipc] git:push", { cwd });
    return git.push(cwd || activeCwd());
  });
  ipcMain.handle("git:pull", async (_event, cwd: string) => {
    debugLog("[ipc] git:pull", { cwd });
    return git.pull(cwd || activeCwd());
  });

  ipcMain.handle("fs:list-dir", async (_event, cwd: string, path: string) =>
    fileService.listDir(cwd || activeCwd(), path),
  );
  ipcMain.handle("fs:read-file", async (_event, cwd: string, path: string) =>
    fileService.readFile(cwd || activeCwd(), path),
  );

  ipcMain.handle("side-terminal:spawn", async (_event, cwd: string) => sideTerminals.spawn(cwd || activeCwd()));
  ipcMain.on("side-terminal:write", (_event, id: string, data: string) => sideTerminals.write(id, data));
  ipcMain.on("side-terminal:resize", (_event, id: string, size: ResizeTerminalRequest) =>
    sideTerminals.resize(id, size.cols, size.rows),
  );
  ipcMain.on("side-terminal:kill", (_event, id: string) => sideTerminals.kill(id));
  sideTerminals.onData((id, data) => sendToRenderer("side-terminal:data", { id, data }));

  ipcMain.handle("models:list", () => models.list(activeCwd()));
  ipcMain.handle("models:login", async (_event, request: ModelLoginRequest) => {
    const state = await models.login(request, activeCwd(), (loginEvent) => {
      sendToRenderer("models:login-event", loginEvent);
      if (loginEvent.type === "auth_url") void shell.openExternal(loginEvent.url);
      if (loginEvent.type === "device_code") void shell.openExternal(loginEvent.verificationUri);
    });
    await reloadActiveRuntime();
    return state;
  });
  ipcMain.on("models:login-response", (_event, response: ModelLoginResponse) => {
    models.respondToLogin(response);
  });
  ipcMain.on("models:cancel-login", () => models.cancelLogin());
  ipcMain.handle("models:logout", async (_event, providerId: string) => {
    const state = await models.logout(providerId, activeCwd());
    await reloadActiveRuntime();
    return state;
  });
  ipcMain.handle("models:set-default", async (_event, request: SetDefaultModelRequest) => {
    const targetPath = request.sessionPath ?? runtime.activeSessionPath;
    const targetCwd = targetPath ? runtime.getStates()[targetPath]?.cwd : undefined;
    const state = await models.setDefault(request, targetCwd ?? activeCwd());
    if (targetPath && runtime.isRunning(targetPath)) {
      runtime.submit(targetPath, `/model ${request.provider}/${request.id}`);
    }
    return state;
  });
  ipcMain.handle("models:custom-list", () => models.listCustomProviders());
  ipcMain.handle("models:custom-save", (_event, request: CustomProviderRequest) => models.saveCustomProvider(request));
  ipcMain.handle("models:custom-remove", (_event, request: CustomProviderRemoveRequest) =>
    models.removeCustomProvider(request),
  );
  ipcMain.handle("models:fetch-models", (_event, request: FetchModelsRequest) => models.fetchModels(request));
  ipcMain.handle("models:catalog-meta", (_event, request: CatalogMetaRequest) => models.catalogMeta(request));

  ipcMain.handle("agent:get-config", () => getAgentConfig());
  ipcMain.handle("agent:save-config", async (_event, request: AgentConfigSaveRequest) => {
    const prev = await getAgentConfig();
    const next = await saveAgentConfig(request.config);
    // Only relaunch live sessions when a launch-argument field changed
    // (pi-runtime re-reads the config on every spawn). thinkingLevel is just
    // the default for *new* sessions — running sessions get the change via
    // /e-pi-thinking — so persisting it must not interrupt in-flight runs.
    const launchArgsChanged =
      prev.systemPrompt !== next.systemPrompt ||
      prev.appendSystemPrompt !== next.appendSystemPrompt ||
      prev.contextFiles !== next.contextFiles;
    if (launchArgsChanged) await reloadActiveRuntime();
    return next;
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    // Wide enough that the session sidebar (320px) + composer minimum
    // (460px) + tool panel (320px) all fit without squeezing the composer.
    minWidth: 1140,
    minHeight: 620,
    title: "E-Pi",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    // Match the first paint: system-dark windows boot to black, light to
    // white, so the native frame doesn't flash against the renderer theme.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#000000" : "#ffffff",
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

runtime.onGlobalData((sessionPath, data) => sendToRenderer("runtime:data", { sessionPath, data }));
runtime.onState((state) => sendToRenderer("runtime:state", state));

// Sidebar titles/counts live off the session files, which pi appends while
// running. Coalesce file-watcher bursts (an entry is written line-by-line)
// into one re-list, then push the fresh list so a new session's title appears
// as soon as the first message lands instead of staying "(no messages)".
let sessionListRefreshTimer: NodeJS.Timeout | undefined;
runtime.onSessionFileChanged(() => {
  if (sessionListRefreshTimer) return;
  sessionListRefreshTimer = setTimeout(() => {
    sessionListRefreshTimer = undefined;
    void sessions
      .list()
      .then((next) => sendToRenderer("sessions:updated", next))
      .catch(() => undefined);
  }, 300);
});
projects.onUpdated((next) => sendToRenderer("projects:updated", next));

// Task-completion banners: busy -> idle on a session raises a native
// notification when it finished in the background.
let notificationHintShown = false;
const notifications = new TaskNotificationService(
  (sessionPath) => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    // Ask the renderer to open this session so the banner click lands on
    // the conversation that finished.
    sendToRenderer("notifications:open-session", sessionPath);
  },
  () => {
    // macOS refuses banners without notification permission and never asks
    // twice — guide the user to the system settings pane, once per run.
    if (notificationHintShown) return;
    notificationHintShown = true;
    void dialog
      .showMessageBox({
        type: "info",
        title: "Notifications are off",
        message: "E-Pi wants to show a notification when a task finishes.",
        detail: app.isPackaged
          ? "Allow notifications for E-Pi in System Settings, then completed tasks will show a banner."
          : 'Allow notifications for "Electron" in System Settings (the dev build shares that app identity; the packaged E-Pi app has its own entry).',
        buttons: ["Open Notification Settings", "Not now"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) void shell.openExternal("x-apple.systempreferences:com.apple.preference.notifications");
      });
  },
);
runtime.onState((state) => {
  notifications.observe(state, {
    activeSessionPath: runtime.activeSessionPath,
    windowFocused: mainWindow?.isFocused() ?? false,
  });
});
packages.setProgressListener((progress) => sendToRenderer("packages:progress", progress));

// Dev builds share the packaged app's userData by default, which makes the
// single-instance lock collide: `pnpm dev` quits immediately while the
// packaged E-Pi is running. Give dev its own userData so both can coexist.
if (!app.isPackaged) {
  app.setPath("userData", app.getPath("userData") + "-dev");
}

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
    resetDebugLog();
    // Packaged apps may miss npm on PATH (spawn npm ENOENT) — resolve it
    // before any package operation can run.
    const npmDir = ensureNpmOnPath();
    debugLog("app started", {
      version: app.getVersion(),
      platform: process.platform,
      ...(npmDir ? { npm: npmDir } : {}),
    });
    registerHandlers();
    void cleanupStalePastedImages();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("before-quit", () => {
    void runtime.stop();
    sideTerminals.killAll();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
