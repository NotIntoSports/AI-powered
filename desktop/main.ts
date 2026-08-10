import path from "node:path";
import { app, BrowserWindow, ipcMain, session } from "electron";

import { registerDesktopIpc } from "./ipc";
import { startLocalServer, stopOwnedProcess } from "./server-process";
import type { DesktopStatus, OwnedProcess } from "./types";

let server: (OwnedProcess & { baseUrl: string }) | null = null;
let mainWindow: BrowserWindow | null = null;

function isAllowedLocalUrl(value: string, baseUrl: string): boolean {
  try {
    const target = new URL(value);
    const base = new URL(baseUrl);
    return target.origin === base.origin;
  } catch {
    return false;
  }
}

export function createMainWindow(baseUrl: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
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
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });
    const runtimeRoot = app.isPackaged
      ? path.join(process.resourcesPath, ".desktop-runtime")
      : path.join(process.cwd(), ".desktop-runtime");
    server = await startLocalServer({
      executablePath: process.execPath,
      serverPath: path.join(runtimeRoot, "server.js"),
      cwd: runtimeRoot
    });
    const getStatus = (): DesktopStatus => ({
      ready: true,
      baseUrl: server?.baseUrl ?? null,
      serverOwned: server?.owned === true
    });
    registerDesktopIpc(ipcMain, getStatus);
    mainWindow = createMainWindow(server.baseUrl);
  }).catch((error) => {
    console.error("Desktop startup failed", error instanceof Error ? error.message : error);
    app.quit();
  });
}

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => { void stopOwnedProcess(server); });
