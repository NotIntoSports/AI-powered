export interface DesktopStatus {
  ready: boolean;
  baseUrl: string | null;
  serverOwned: boolean;
}

export interface PrerequisiteStatus {
  obsBundled: boolean;
  virtualCameraRegistered: boolean;
  virtualAudioInstalled: boolean;
  virtualAudioDriverStaged: boolean;
}

export interface DesktopBridge {
  getStatus(): Promise<DesktopStatus>;
  listMeetingProcesses(): Promise<Array<{ pid: number; name: string; title: string }>>;
  startAudioCapture(pid: number): Promise<{ started: true }>;
  stopAudioCapture(): Promise<{ stopped: true }>;
  onAudioPcm(listener: (data: Uint8Array) => void): () => void;
  onAudioEvent(listener: (event: unknown) => void): () => void;
  getPrerequisiteStatus(): Promise<PrerequisiteStatus>;
  installPrerequisite(component: "obs" | "virtual-audio"): Promise<PrerequisiteInstallResult>;
  ensureManagedObs(): Promise<ManagedObsState>;
  getManagedObsState(): Promise<ManagedObsState>;
  setManagedObsVirtualCamera(active: boolean): Promise<ManagedObsState>;
  setManagedObsInterventionRouting(action: "begin" | "end" | "resume" | "mute"): Promise<ManagedObsState>;
  stopManagedObs(): Promise<ManagedObsState>;
  resetManagedObsConfig(): Promise<ManagedObsState>;
  openMicrophoneSettings(): Promise<{ opened: boolean }>;
}

export type ManagedObsState =
  | { status: "idle" | "stopped" }
  | { status: "not-installed" }
  | { status: "blocked-by-external-obs"; processes: number[] }
  | { status: "starting"; attempt: number; maxAttempts: number }
  | { status: "ready"; version: string; virtualCameraActive: boolean }
  | { status: "failed"; stage: "configuration" | "process" | "port" | "auth" | "scene" | "virtual-camera"; code: string };

export type PrerequisiteInstallErrorCode =
  | "uac-cancelled"
  | "resource-missing"
  | "signature-rejected"
  | "hash-mismatch"
  | "registration-failed"
  | "install-failed"
  | "unknown";

export type PrerequisiteInstallResult =
  | { installed: true; rebootRequired: boolean }
  | { installed: false; error: { code: PrerequisiteInstallErrorCode; message: string } };

export interface OwnedProcess {
  owned: boolean;
  child: { kill(signal?: NodeJS.Signals): boolean };
}
