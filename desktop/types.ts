export interface DesktopStatus {
  ready: boolean;
  baseUrl: string | null;
  serverOwned: boolean;
}

export interface DesktopBridge {
  getStatus(): Promise<DesktopStatus>;
  listMeetingProcesses(): Promise<Array<{ pid: number; name: string; title: string }>>;
  startAudioCapture(pid: number): Promise<{ started: true }>;
  stopAudioCapture(): Promise<{ stopped: true }>;
  onAudioPcm(listener: (data: Uint8Array) => void): () => void;
  onAudioEvent(listener: (event: unknown) => void): () => void;
  getPrerequisiteStatus(): Promise<{ obsInstalled: boolean; virtualAudioInstalled: boolean }>;
  installPrerequisite(component: "obs" | "virtual-audio"): Promise<{ installed: true }>;
}

export interface OwnedProcess {
  owned: boolean;
  child: { kill(signal?: NodeJS.Signals): boolean };
}
