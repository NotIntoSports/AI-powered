import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "./types";

const bridge: DesktopBridge = Object.freeze({
  getStatus: () => ipcRenderer.invoke("desktop:get-status")
});

contextBridge.exposeInMainWorld("aiInterviewerDesktop", bridge);
