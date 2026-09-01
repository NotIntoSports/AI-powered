import {
  loadVirtualAudioRoute,
  resolvePreferredVirtualAudioRoute,
  type StoredVirtualAudioRoute,
} from "./virtual-audio-route.ts";
import { classifyAudioDevices } from "./audio-devices.ts";

type BridgeMediaDevices = {
  enumerateDevices(): Promise<ArrayLike<{ kind: string; label: string; deviceId: string }>>;
  getUserMedia(constraints: MediaStreamConstraints): Promise<Pick<MediaStream, "getTracks">>;
};

type BridgeAudio = {
  srcObject: MediaProvider | null;
  autoplay: boolean;
  setSinkId?(deviceId: string): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  remove(): void;
};

export type HumanMicrophoneBridge = {
  outputLabel: string;
  stop(): void;
};

export async function startHumanMicrophoneBridge(options: {
  route?: StoredVirtualAudioRoute | null;
  mediaDevices?: BridgeMediaDevices;
  createAudio?: () => BridgeAudio;
} = {}): Promise<HumanMicrophoneBridge> {
  const mediaDevices = options.mediaDevices || navigator.mediaDevices;
  const stored = Object.prototype.hasOwnProperty.call(options, "route")
    ? options.route || null
    : loadVirtualAudioRoute();
  const devices = Array.from(await mediaDevices.enumerateDevices());
  const candidates = devices
    .filter((device) => device.kind === "audioinput" || device.kind === "audiooutput")
    .map((device) => ({
      kind: device.kind as "audioinput" | "audiooutput",
      label: device.label,
      deviceId: device.deviceId,
    }));
  const resolved = stored
    ? resolvePreferredVirtualAudioRoute(stored, candidates)
    : classifyAudioDevices(candidates).routes[0] || null;
  if (!resolved?.outputDeviceId) throw new Error("VIRTUAL_AUDIO_ROUTE_NOT_READY");

  const stream = await mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
  const audio = options.createAudio ? options.createAudio() : new Audio();
  if (!audio.setSinkId) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("SET_SINK_ID_UNSUPPORTED");
  }
  try {
    await audio.setSinkId(resolved.outputDeviceId);
    audio.srcObject = stream as MediaProvider;
    audio.autoplay = true;
    await audio.play();
  } catch (error) {
    audio.pause();
    audio.srcObject = null;
    stream.getTracks().forEach((track) => track.stop());
    audio.remove();
    throw error;
  }

  let stopped = false;
  return {
    outputLabel: resolved.output,
    stop() {
      if (stopped) return;
      stopped = true;
      audio.pause();
      audio.srcObject = null;
      stream.getTracks().forEach((track) => track.stop());
      audio.remove();
    },
  };
}
