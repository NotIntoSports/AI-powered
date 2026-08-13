import { shell, type BrowserWindow, type IpcMain } from "electron";
import { AudioCaptureProcess } from "./audio/capture-process";
import { listMeetingProcesses } from "./audio/meeting-processes";
import { getPrerequisiteStatus, installPrerequisite } from "./prerequisites/windows-install";
import type { DesktopStatus, ManagedObsState } from "./types";

export function registerDesktopIpc(
  ipcMain: IpcMain,
  getStatus: () => DesktopStatus,
  getWindow: () => BrowserWindow | null,
  audioBridgePath: string,
  installResources?: { scriptPath: string; directory: string },
  obsManager?: { ensure(): Promise<ManagedObsState>; reset(): Promise<ManagedObsState> }
): void {
  ipcMain.handle("desktop:get-status", () => getStatus());
  const capture = new AudioCaptureProcess();
  ipcMain.handle("desktop:list-meeting-processes", () => listMeetingProcesses());
  ipcMain.handle("desktop:start-audio-capture", async (_event, rawPid: unknown) => {
    if (!Number.isInteger(rawPid) || Number(rawPid) <= 0) throw new Error("INVALID_MEETING_PROCESS");
    const pid = Number(rawPid);
    const allowed = await listMeetingProcesses();
    if (!allowed.some((process) => process.pid === pid)) throw new Error("MEETING_PROCESS_NOT_AVAILABLE");
    capture.start({
      executablePath: audioBridgePath,
      pid,
      onPcm: (data) => getWindow()?.webContents.send("desktop:audio-pcm", data),
      onEvent: (event) => getWindow()?.webContents.send("desktop:audio-event", event)
    });
    return { started: true as const };
  });
  ipcMain.handle("desktop:stop-audio-capture", () => {
    capture.stop();
    return { stopped: true as const };
  });
  ipcMain.handle("desktop:get-prerequisite-status", () => getPrerequisiteStatus());
  ipcMain.handle("desktop:install-prerequisite", async (_event, component: unknown) => {
    if (component !== "obs" && component !== "virtual-audio") throw new Error("INVALID_PREREQUISITE");
    if (!installResources) throw new Error("PREREQUISITES_NOT_PACKAGED");
    return installPrerequisite({ component, scriptPath: installResources.scriptPath, resourcesDirectory: installResources.directory });
  });
  ipcMain.handle("desktop:ensure-managed-obs", () => {
    if (!obsManager) throw new Error("OBS_MANAGER_UNAVAILABLE");
    return obsManager.ensure();
  });
  ipcMain.handle("desktop:reset-managed-obs-config", () => {
    if (!obsManager) throw new Error("OBS_MANAGER_UNAVAILABLE");
    return obsManager.reset();
  });
  ipcMain.handle("desktop:open-microphone-settings", async () => ({
    opened: (await shell.openExternal("ms-settings:privacy-microphone")) === undefined
  }));
}
