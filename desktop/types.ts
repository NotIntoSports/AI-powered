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
  getPrerequisiteStatus(): Promise<{ obsInstalled: boolean; virtualAudioInstalled: boolean; virtualAudioDriverStaged: boolean }>;
  installPrerequisite(component: "obs" | "virtual-audio"): Promise<PrerequisiteInstallResult>;
  ensureManagedObs(): Promise<ManagedObsState>;
  resetManagedObsConfig(): Promise<ManagedObsState>;
  openMicrophoneSettings(): Promise<{ opened: boolean }>;
}

export type ManagedObsState =
  | { status: "not-installed" }
  | { status: "blocked-by-external-obs"; processes: number[] }
  | { status: "starting"; attempt: number; maxAttempts: 5 }
  | { status: "ready"; port: number; virtualCameraActive: boolean; url: string; password: string; stageUrl: string }
  | { status: "failed"; stage: "process" | "port" | "auth" | "scene" | "virtual-camera"; code: string };

export type PrerequisiteInstallErrorCode =
  | "uac-cancelled"
  | "resource-missing"
  | "signature-rejected"
  | "install-failed"
  | "unknown";

export type PrerequisiteInstallResult =
  | { installed: true; rebootRequired: boolean }
  | { installed: false; error: { code: PrerequisiteInstallErrorCode; message: string } };

export interface OwnedProcess {
  owned: boolean;
  child: { kill(signal?: NodeJS.Signals): boolean };
}
