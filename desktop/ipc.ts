import type { BrowserWindow, IpcMain } from "electron";
import { AudioCaptureProcess } from "./audio/capture-process";
import { listMeetingProcesses } from "./audio/meeting-processes";
import type { DesktopStatus } from "./types";

export function registerDesktopIpc(
  ipcMain: IpcMain,
  getStatus: () => DesktopStatus,
  getWindow: () => BrowserWindow | null,
  audioBridgePath: string
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
}
