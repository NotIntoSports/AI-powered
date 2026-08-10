export interface DesktopStatus {
  ready: boolean;
  baseUrl: string | null;
  serverOwned: boolean;
}

export interface DesktopBridge {
  getStatus(): Promise<DesktopStatus>;
}

export interface OwnedProcess {
  owned: boolean;
  child: { kill(signal?: NodeJS.Signals): boolean };
}
