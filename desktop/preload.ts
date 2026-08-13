import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "./types";

const bridge: DesktopBridge = Object.freeze({
  getStatus: () => ipcRenderer.invoke("desktop:get-status"),
  listMeetingProcesses: () => ipcRenderer.invoke("desktop:list-meeting-processes"),
  startAudioCapture: (pid: number) => ipcRenderer.invoke("desktop:start-audio-capture", pid),
  stopAudioCapture: () => ipcRenderer.invoke("desktop:stop-audio-capture"),
  onAudioPcm: (listener: (data: Uint8Array) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: Uint8Array) => listener(data);
    ipcRenderer.on("desktop:audio-pcm", handler);
    return () => ipcRenderer.removeListener("desktop:audio-pcm", handler);
  },
  onAudioEvent: (listener: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => listener(data);
    ipcRenderer.on("desktop:audio-event", handler);
    return () => ipcRenderer.removeListener("desktop:audio-event", handler);
  },
  getPrerequisiteStatus: () => ipcRenderer.invoke("desktop:get-prerequisite-status"),
  installPrerequisite: (component: "obs" | "virtual-audio") => ipcRenderer.invoke("desktop:install-prerequisite", component),
  ensureManagedObs: () => ipcRenderer.invoke("desktop:ensure-managed-obs"),
  resetManagedObsConfig: () => ipcRenderer.invoke("desktop:reset-managed-obs-config"),
  openMicrophoneSettings: () => ipcRenderer.invoke("desktop:open-microphone-settings")
});

contextBridge.exposeInMainWorld("aiInterviewerDesktop", bridge);
