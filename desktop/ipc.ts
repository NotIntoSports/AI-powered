import { shell, type BrowserWindow, type IpcMain } from "electron";
import path from "node:path";
import { AudioCaptureProcess } from "./audio/capture-process";
import { CommunicationsMicrophoneRouter } from "./audio/communications-microphone-router";
import { listMeetingProcesses } from "./audio/meeting-processes";
import { getPrerequisiteStatus, installPrerequisite, ensureVirtualAudioResources } from "./prerequisites/windows-install";
import type { DesktopStatus, ManagedObsState } from "./types";
import type { InterventionAction } from "./obs-scene";

type ManagedObsIpcController = {
  ensure(): Promise<ManagedObsState>;
  getState(): Promise<ManagedObsState>;
  setVirtualCamera(active: boolean): Promise<ManagedObsState>;
  setInterventionRouting(action: InterventionAction): Promise<ManagedObsState>;
  stop(): Promise<ManagedObsState>;
  reset(): Promise<ManagedObsState>;
};

type InstallResources = {
  scriptPath: string;
  fetchScriptPath: string;
  directory: string;
  userDataDirectory: string;
};

export function registerDesktopIpc(
  ipcMain: IpcMain,
  getStatus: () => DesktopStatus,
  getWindow: () => BrowserWindow | null,
  audioBridgePath: string,
  installResources?: InstallResources,
  obsManager?: ManagedObsIpcController
): () => Promise<void> {
  ipcMain.handle("desktop:get-status", () => getStatus());
  const capture = new AudioCaptureProcess();
  const communicationsMicrophone = new CommunicationsMicrophoneRouter();
  const sendToRenderer = (channel: string, payload: unknown) => {
    const window = getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    try {
      window.webContents.send(channel, payload);
    } catch (error) {
      // Window teardown can race with a final AudioBridge stdout event.
      if (window.isDestroyed() || window.webContents.isDestroyed()) return;
      throw error;
    }
  };
  ipcMain.handle("desktop:list-meeting-processes", () => listMeetingProcesses());
  ipcMain.handle("desktop:start-audio-capture", async (_event, rawPid: unknown) => {
    if (!Number.isInteger(rawPid) || Number(rawPid) <= 0) throw new Error("INVALID_MEETING_PROCESS");
    const pid = Number(rawPid);
    const allowed = await listMeetingProcesses();
    if (!allowed.some((process) => process.pid === pid)) throw new Error("MEETING_PROCESS_NOT_AVAILABLE");
    await communicationsMicrophone.activate(audioBridgePath, pid);
    capture.start({
      executablePath: audioBridgePath,
      pid,
      onPcm: (data) => sendToRenderer("desktop:audio-pcm", data),
      onEvent: (event) => {
        sendToRenderer("desktop:audio-event", event);
        if (event.type === "process-exited") void communicationsMicrophone.restore(audioBridgePath);
      }
    });
    return { started: true as const };
  });
  ipcMain.handle("desktop:stop-audio-capture", async () => {
    capture.stop();
    await communicationsMicrophone.restore(audioBridgePath);
    return { stopped: true as const };
  });
  ipcMain.handle("desktop:get-prerequisite-status", () => {
    if (!installResources) return getPrerequisiteStatus();
    return getPrerequisiteStatus(installResources.directory, [installResources.userDataDirectory]);
  });
  ipcMain.handle("desktop:ensure-virtual-audio", () => {
    if (!installResources) throw new Error("PREREQUISITES_NOT_PACKAGED");
    return ensureVirtualAudioResources({
      fetchScriptPath: installResources.fetchScriptPath,
      resourcesDirectory: installResources.directory,
      userDataDirectory: installResources.userDataDirectory
    });
  });
  ipcMain.handle("desktop:install-prerequisite", async (_event, component: unknown) => {
    if (component !== "obs" && component !== "virtual-audio") throw new Error("INVALID_PREREQUISITE");
    if (!installResources) throw new Error("PREREQUISITES_NOT_PACKAGED");
    return installPrerequisite({
      component,
      scriptPath: installResources.scriptPath,
      resourcesDirectory: installResources.directory,
      extraResourceDirectories: [installResources.userDataDirectory],
      logDirectory: path.join(installResources.userDataDirectory, "..", "logs")
    });
  });
  ipcMain.handle("desktop:ensure-managed-obs", () => {
    if (!obsManager) throw new Error("OBS_MANAGER_UNAVAILABLE");
    return obsManager.ensure();
  });
  ipcMain.handle("desktop:get-managed-obs-state", () => {
    if (!obsManager) throw new Error("OBS_MANAGER_UNAVAILABLE");
    return obsManager.getState();
  });
  ipcMain.handle("desktop:set-managed-obs-virtual-camera", (_event, active: unknown) => {
    if (!obsManager) throw new Error("OBS_MANAGER_UNAVAILABLE");
    if (typeof active !== "boolean") throw new Error("INVALID_OBS_VIRTUAL_CAMERA_STATE");
    return obsManager.setVirtualCamera(active);
  });
  ipcMain.handle("desktop:set-managed-obs-intervention-routing", (_event, action: unknown) => {
    if (!obsManager) throw new Error("OBS_MANAGER_UNAVAILABLE");
    if (action !== "begin" && action !== "end" && action !== "resume" && action !== "mute") {
      throw new Error("INVALID_OBS_INTERVENTION_ACTION");
    }
    return obsManager.setInterventionRouting(action);
  });
  ipcMain.handle("desktop:stop-managed-obs", () => {
    if (!obsManager) throw new Error("OBS_MANAGER_UNAVAILABLE");
    return obsManager.stop();
  });
  ipcMain.handle("desktop:reset-managed-obs-config", () => {
    if (!obsManager) throw new Error("OBS_MANAGER_UNAVAILABLE");
    return obsManager.reset();
  });
  ipcMain.handle("desktop:open-microphone-settings", async () => ({
    opened: (await shell.openExternal("ms-settings:privacy-microphone")) === undefined
  }));
  return async () => {
    capture.stop();
    await communicationsMicrophone.restore(audioBridgePath).catch(() => undefined);
  };
}
