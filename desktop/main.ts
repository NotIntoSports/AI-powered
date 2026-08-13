import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, safeStorage, session } from "electron";

import { registerDesktopIpc } from "./ipc";
import { ManagedObsController } from "./managed-obs";
import { ManagedObsSecretStore } from "./obs-secret-store";
import { getPrerequisiteStatus } from "./prerequisites/windows-install";
import { LocalServerStartError, startLocalServer, stopOwnedProcess } from "./server-process";
import type { DesktopStatus, OwnedProcess } from "./types";

let server: (OwnedProcess & { baseUrl: string }) | null = null;
let obsManager: ManagedObsController | null = null;
let mainWindow: BrowserWindow | null = null;

app.setName("AI Digital Human");

function isAllowedLocalUrl(value: string, baseUrl: string): boolean {
  try {
    const target = new URL(value);
    const base = new URL(baseUrl);
    return target.origin === base.origin;
  } catch {
    return false;
  }
}

export function isAllowedMediaPermission(permission: string, requestingUrl: string, baseUrl: string): boolean {
  return permission === "media" && isAllowedLocalUrl(requestingUrl, baseUrl);
}

export function createMainWindow(baseUrl: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0d1118",
      symbolColor: "#d7deea",
      height: 36
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedLocalUrl(url, baseUrl)) event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());
  void window.loadURL(baseUrl);
  return window;
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

  app.whenReady().then(async () => {
    const runtimeRoot = app.isPackaged
      ? path.join(process.resourcesPath, ".desktop-runtime")
      : path.join(process.cwd(), ".desktop-runtime");
    server = await startLocalServer({
      executablePath: process.execPath,
      serverPath: path.join(runtimeRoot, "server.js"),
      cwd: runtimeRoot,
      logPath: path.join(app.getPath("userData"), "logs", "desktop-startup.log")
    });
    const baseUrl = server.baseUrl;
    session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) =>
      isAllowedMediaPermission(permission, details.requestingUrl || requestingOrigin, baseUrl)
    );
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
      callback(isAllowedMediaPermission(permission, details.requestingUrl, baseUrl));
    });
    const prerequisitesDirectory = app.isPackaged
      ? path.join(process.resourcesPath, "prerequisites")
      : path.join(process.cwd(), "resources", "prerequisites");
    const obsTemplateRoot = path.join(prerequisitesDirectory, "obs-portable");
    obsManager = new ManagedObsController({
      templateRoot: obsTemplateRoot,
      runtimeRoot: path.join(app.getPath("userData"), "runtime", "obs", "32.2.1"),
      stageUrl: `${baseUrl}/stage`,
      secretStore: new ManagedObsSecretStore(
        path.join(app.getPath("userData"), "secrets", "managed-obs-password.bin"),
        safeStorage
      ),
      packagedVersion: "32.2.1",
      isVirtualCameraRegistered: () => getPrerequisiteStatus(prerequisitesDirectory).virtualCameraRegistered
    });
    const getStatus = (): DesktopStatus => ({
      ready: true,
      baseUrl: server?.baseUrl ?? null,
      serverOwned: server?.owned === true
    });
    mainWindow = createMainWindow(server.baseUrl);
    registerDesktopIpc(
      ipcMain,
      getStatus,
      () => mainWindow,
      app.isPackaged
        ? path.join(process.resourcesPath, "audio-bridge", "AudioBridge.exe")
        : path.join(process.cwd(), "native", "AudioBridge", "publish", "AudioBridge.exe"),
      {
        scriptPath: app.isPackaged
          ? path.join(process.resourcesPath, "scripts", "install-prerequisite.ps1")
          : path.join(process.cwd(), "scripts", "install-prerequisite.ps1"),
        directory: prerequisitesDirectory
      },
      obsManager
    );
  }).catch((error) => {
    console.error("Desktop startup failed", error instanceof Error ? error.message : error);
    const message = error instanceof LocalServerStartError
      ? `${error.message}\n\n启动日志：${error.logPath}`
      : error instanceof Error ? error.message : String(error);
    dialog.showErrorBox("AI 数字人启动失败", message);
    app.quit();
  });
}

app.on("window-all-closed", () => app.quit());
let shutdownStarted = false;
app.on("before-quit", (event) => {
  if (shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  void Promise.all([
    stopOwnedProcess(server),
    obsManager?.stop() ?? Promise.resolve()
  ]).finally(() => app.quit());
});
