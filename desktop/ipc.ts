import type { IpcMain } from "electron";
import type { DesktopStatus } from "./types";

export function registerDesktopIpc(
  ipcMain: IpcMain,
  getStatus: () => DesktopStatus
): void {
  ipcMain.handle("desktop:get-status", () => getStatus());
}
