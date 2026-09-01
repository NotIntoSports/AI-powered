export type AgentAudioRoute = "virtual-output" | "local-monitor";
export type AgentAudioRouteState = "starting" | "playing" | "blocked" | "failed" | "stopped";

export type AgentAudioRouteStatus = {
  trackId: string;
  route: AgentAudioRoute;
  state: AgentAudioRouteState;
  code?: string;
  endpointLabel?: string;
  signalState?: "checking" | "detected" | "unverified" | "missing";
};

export type AgentVirtualOutput = { deviceId: string; endpointLabel: string; inputDeviceId?: string };

type AudioElementLike = {
  setSinkId?: (deviceId: string) => Promise<void>;
  play(): Promise<void>;
  pause(): void;
  remove(): void;
};

export type AgentAudioTrackLike = {
  sid?: string;
  attach(): AudioElementLike;
  detach(element: AudioElementLike): unknown;
};

type Playback = {
  generation: number;
  monitorGeneration: number;
  virtual?: AudioElementLike;
  monitor?: AudioElementLike;
  monitorStarting?: Promise<void>;
};

type Options = {
  resolveVirtualOutputDeviceId(attempt?: 0 | 1): Promise<string | AgentVirtualOutput>;
  verifyVirtualSignal?: (route: AgentVirtualOutput) => Promise<"detected" | "unverified" | "missing">;
  startRoomAudio?: () => Promise<void>;
  onStatus?: (status: AgentAudioRouteStatus) => void;
};

function errorCode(error: unknown) {
  if (!(error instanceof Error)) return String(error || "PLAYBACK_FAILED");
  return error.name && error.name !== "Error" ? error.name : error.message;
}

function isPlaybackBlocked(error: unknown) {
  return error instanceof Error && (error.name === "NotAllowedError" || error.name === "AbortError");
}

export class AgentAudioPlaybackController {
  private readonly options: Options;
  private readonly tracks = new Map<AgentAudioTrackLike, Playback>();
  private monitorEnabled = true;
  private nextGeneration = 0;

  constructor(options: Options) {
    this.options = options;
  }

  private emit(track: AgentAudioTrackLike, route: AgentAudioRoute, state: AgentAudioRouteState, code?: string, extra?: Partial<AgentAudioRouteStatus>) {
    this.options.onStatus?.({ trackId: track.sid || "unknown", route, state, code, ...extra });
  }

  private stopElement(track: AgentAudioTrackLike, element: AudioElementLike | undefined, route: AgentAudioRoute) {
    if (!element) return;
    track.detach(element);
    element.pause();
    element.remove();
    this.emit(track, route, "stopped");
  }

  private current(track: AgentAudioTrackLike, playback: Playback, generation: number) {
    return this.tracks.get(track) === playback && playback.generation === generation;
  }

  private async startVirtual(track: AgentAudioTrackLike, playback: Playback, attempt: 0 | 1 = 0): Promise<boolean> {
    const generation = playback.generation;
    let element: AudioElementLike | undefined;
    this.emit(track, "virtual-output", "starting");
    try {
      const resolved = await this.options.resolveVirtualOutputDeviceId(attempt);
      const route = typeof resolved === "string" ? { deviceId: resolved, endpointLabel: resolved } : resolved;
      if (!this.current(track, playback, generation)) return false;
      element = track.attach();
      playback.virtual = element;
      if (!element.setSinkId) throw new Error("SET_SINK_ID_UNSUPPORTED");
      await element.setSinkId(route.deviceId);
      if (!this.current(track, playback, generation)) {
        if (playback.virtual === element) playback.virtual = undefined;
        this.stopElement(track, element, "virtual-output");
        return false;
      }
      await element.play();
      if (!this.current(track, playback, generation)) {
        this.stopElement(track, element, "virtual-output");
        return false;
      }
      this.emit(track, "virtual-output", "playing", undefined, { endpointLabel: route.endpointLabel, signalState: this.options.verifyVirtualSignal ? "checking" : "unverified" });
      if (this.options.verifyVirtualSignal) {
        const signalState = await this.options.verifyVirtualSignal(route).catch(() => "unverified" as const);
        if (signalState === "missing" && attempt === 0 && this.current(track, playback, generation)) {
          if (playback.virtual === element) playback.virtual = undefined;
          this.stopElement(track, element, "virtual-output");
          return this.startVirtual(track, playback, 1);
        }
        if (this.current(track, playback, generation)) {
          this.emit(track, "virtual-output", "playing", signalState === "missing" ? "VIRTUAL_OUTPUT_SIGNAL_MISSING" : undefined, { endpointLabel: route.endpointLabel, signalState });
        }
      }
      return true;
    } catch (error) {
      if (element) {
        if (playback.virtual === element) playback.virtual = undefined;
        this.stopElement(track, element, "virtual-output");
      }
      this.emit(track, "virtual-output", isPlaybackBlocked(error) ? "blocked" : "failed", errorCode(error));
      return false;
    }
  }

  private startMonitor(track: AgentAudioTrackLike, playback: Playback) {
    if (!this.monitorEnabled || playback.monitor || playback.monitorStarting) return playback.monitorStarting || Promise.resolve();
    const monitorGeneration = ++playback.monitorGeneration;
    const generation = playback.generation;
    this.emit(track, "local-monitor", "starting");
    const starting = (async () => {
      const element = track.attach();
      playback.monitor = element;
      try {
        await element.play();
        if (!this.current(track, playback, generation) || playback.monitorGeneration !== monitorGeneration || !this.monitorEnabled) {
          if (playback.monitor === element) playback.monitor = undefined;
          this.stopElement(track, element, "local-monitor");
          return;
        }
        this.emit(track, "local-monitor", "playing");
      } catch (error) {
        if (playback.monitor === element) playback.monitor = undefined;
        this.stopElement(track, element, "local-monitor");
        this.emit(track, "local-monitor", isPlaybackBlocked(error) ? "blocked" : "failed", errorCode(error));
      }
    })().finally(() => {
      if (playback.monitorStarting === starting) playback.monitorStarting = undefined;
    });
    playback.monitorStarting = starting;
    return starting;
  }

  async addTrack(track: AgentAudioTrackLike, monitorEnabled: boolean) {
    this.removeTrack(track);
    this.monitorEnabled = monitorEnabled;
    const playback: Playback = { generation: ++this.nextGeneration, monitorGeneration: 0 };
    this.tracks.set(track, playback);
    if (await this.startVirtual(track, playback)) await this.startMonitor(track, playback);
  }

  async setMonitorEnabled(enabled: boolean) {
    this.monitorEnabled = enabled;
    const pending: Promise<void>[] = [];
    for (const [track, playback] of this.tracks) {
      if (!enabled) {
        playback.monitorGeneration += 1;
        const monitor = playback.monitor;
        playback.monitor = undefined;
        playback.monitorStarting = undefined;
        this.stopElement(track, monitor, "local-monitor");
      } else if (playback.virtual) {
        pending.push(this.startMonitor(track, playback));
      }
    }
    await Promise.all(pending);
  }

  markPlaybackBlocked() {
    for (const [track, playback] of this.tracks) {
      if (playback.virtual) this.emit(track, "virtual-output", "blocked", "AUTOPLAY_BLOCKED");
      if (playback.monitor) this.emit(track, "local-monitor", "blocked", "AUTOPLAY_BLOCKED");
    }
  }

  async retryPlayback() {
    await this.options.startRoomAudio?.();
    for (const [track, playback] of this.tracks) {
      playback.generation = ++this.nextGeneration;
      playback.monitorGeneration += 1;
      const virtual = playback.virtual;
      const monitor = playback.monitor;
      playback.virtual = undefined;
      playback.monitor = undefined;
      this.stopElement(track, monitor, "local-monitor");
      this.stopElement(track, virtual, "virtual-output");
      if (await this.startVirtual(track, playback)) await this.startMonitor(track, playback);
    }
  }

  removeTrack(track: AgentAudioTrackLike) {
    const playback = this.tracks.get(track);
    if (!playback) return;
    playback.generation = ++this.nextGeneration;
    playback.monitorGeneration += 1;
    this.tracks.delete(track);
    this.stopElement(track, playback.monitor, "local-monitor");
    this.stopElement(track, playback.virtual, "virtual-output");
  }

  clear() {
    for (const track of [...this.tracks.keys()]) this.removeTrack(track);
  }
}
