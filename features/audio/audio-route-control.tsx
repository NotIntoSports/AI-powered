"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  classifyAudioDevices,
  type AudioDeviceCandidate,
  type VirtualAudioRoute
} from "./audio-devices";
import { calculatePcmRms, hasMeaningfulAudioSignal } from "./audio-signal";
import {
  clearVirtualAudioRoute,
  loadVirtualAudioRoute,
  resolvePreferredVirtualAudioRoute,
  saveVirtualAudioRoute
} from "./virtual-audio-route";
import {
  formatPrerequisiteInstallError,
  getManagedObsDesktopBridge
} from "../obs/managed-obs-state";
import {
  getSnapshotReadiness,
  loadReadinessSnapshot,
  setReadinessVerification
} from "../readiness/readiness-snapshot";

type RouteState = "idle" | "checking" | "ready" | "missing" | "denied" | "reboot";

type AudioRouteControlProps = {
  onReadyChange?: (ready: boolean) => void;
};

type PermissionBridge = { openMicrophoneSettings(): Promise<{ opened: boolean }> };
type SinkAudioElement = HTMLAudioElement & { setSinkId?: (deviceId: string) => Promise<void> };
type SelectableMediaDevices = MediaDevices & {
  selectAudioOutput?: (options?: { deviceId?: string }) => Promise<MediaDeviceInfo>;
};

const RENEWAL_INTERVAL_MS = 4 * 60_000;
const AUTO_CHECK_DELAY_MS = 800;
const DEVICE_CHANGE_DEBOUNCE_MS = 1_500;

const DEFAULT_IDLE_MESSAGE =
  "把 AI 语音送进会议麦克风。已安装 VB-CABLE 时打开页面会自动检测；未安装时点下方按钮授权安装。";

let silentCheckRunning = false;

export function AudioRouteControl({ onReadyChange }: AudioRouteControlProps) {
  const readyRef = useRef(false);
  const stateRef = useRef<RouteState>("idle");
  const renewalTimerRef = useRef<number | null>(null);
  const checkGenerationRef = useRef(0);
  const restoredRef = useRef(false);
  const [state, setState] = useState<RouteState>("idle");
  const [inputs, setInputs] = useState<string[]>([]);
  const [outputs, setOutputs] = useState<string[]>([]);
  const [message, setMessage] = useState(DEFAULT_IDLE_MESSAGE);

  const updateState = useCallback((next: RouteState) => {
    if (renewalTimerRef.current !== null) {
      window.clearTimeout(renewalTimerRef.current);
      renewalTimerRef.current = null;
    }
    readyRef.current = next === "ready";
    stateRef.current = next;
    setState(next);
    onReadyChange?.(next === "ready");
    if (next !== "ready" && next !== "checking") clearVirtualAudioRoute();
  }, [onReadyChange]);

  function scheduleRenewal() {
    if (renewalTimerRef.current !== null) window.clearTimeout(renewalTimerRef.current);
    renewalTimerRef.current = window.setTimeout(() => {
      renewalTimerRef.current = null;
      renewRef.current();
    }, RENEWAL_INTERVAL_MS);
  }

  function applyReady(route: VirtualAudioRoute, persist: boolean) {
    if (persist) saveVirtualAudioRoute({ ...route, verifiedAt: Date.now() });
    if (renewalTimerRef.current !== null) {
      window.clearTimeout(renewalTimerRef.current);
      renewalTimerRef.current = null;
    }
    readyRef.current = true;
    stateRef.current = "ready";
    setState("ready");
    onReadyChange?.(true);
    setMessage(
      `${route.label} 端到端信号通过：播放“${route.output}”已到达会议麦克风“${route.input}”。请在会议软件里选择该麦克风。`
    );
    scheduleRenewal();
  }

  async function measurePeakRms(
    analyser: AnalyserNode,
    durationMs: number,
    generation: number,
    stopWhenSignalExceeds?: number
  ) {
    const samples = new Uint8Array(analyser.fftSize);
    const deadline = performance.now() + durationMs;
    let peakRms = 0;
    while (performance.now() < deadline && checkGenerationRef.current === generation) {
      analyser.getByteTimeDomainData(samples);
      peakRms = Math.max(peakRms, calculatePcmRms(samples));
      if (stopWhenSignalExceeds !== undefined && peakRms >= stopWhenSignalExceeds) break;
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    return peakRms;
  }

  async function requestAudioStream(
    constraints: MediaStreamConstraints,
    generation: number
  ) {
    let expired = false;
    const request = navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
      if (expired || checkGenerationRef.current !== generation) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("DEVICE_CHECK_CANCELLED");
      }
      return stream;
    });
    let timeoutId = 0;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = window.setTimeout(
        () => reject(new Error("麦克风授权等待超时，请允许权限后重试。")),
        20_000
      );
    });
    try {
      return await Promise.race([request, timeout]);
    } finally {
      expired = true;
      window.clearTimeout(timeoutId);
    }
  }

  async function playToneToOutput(outputDeviceId: string, generation: number) {
    const url = URL.createObjectURL(createBeepWav());
    const audio = new Audio(url) as SinkAudioElement;
    try {
      if (audio.setSinkId) await audio.setSinkId(outputDeviceId);
      if (checkGenerationRef.current !== generation) throw new Error("DEVICE_CHECK_CANCELLED");
      const ended = new Promise<void>((resolve) => {
        audio.onended = () => resolve();
        window.setTimeout(resolve, 1_400);
      });
      await audio.play();
      await ended;
    } finally {
      audio.pause();
      audio.src = "";
      URL.revokeObjectURL(url);
    }
  }

  async function verifyRouteSignal(inputDeviceId: string, outputDeviceId: string, generation: number) {
    const stream = await requestAudioStream({
      audio: {
        deviceId: { exact: inputDeviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      video: false
    }, generation);
    const AudioContextClass = window.AudioContext;
    if (!AudioContextClass) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error("当前浏览器不支持 Web Audio 线路检测。");
    }
    const context = new AudioContextClass();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    try {
      await context.resume();
      const baselineRms = await measurePeakRms(analyser, 600, generation);
      if (checkGenerationRef.current !== generation) throw new Error("DEVICE_CHECK_CANCELLED");
      const requiredRms = Math.max(0.015, baselineRms * 3 + 0.004);
      const listen = measurePeakRms(analyser, 2_000, generation, requiredRms);
      await playToneToOutput(outputDeviceId, generation);
      const peakRms = await listen;
      if (checkGenerationRef.current !== generation) throw new Error("DEVICE_CHECK_CANCELLED");
      return hasMeaningfulAudioSignal(peakRms, baselineRms);
    } finally {
      source.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      await context.close().catch(() => undefined);
    }
  }

  async function readDeviceCandidates(): Promise<AudioDeviceCandidate[]> {
    return (await navigator.mediaDevices.enumerateDevices())
      .filter((device) => device.kind === "audioinput" || device.kind === "audiooutput")
      .map((device) => ({
        kind: device.kind as "audioinput" | "audiooutput",
        label: device.label,
        deviceId: device.deviceId
      }));
  }

  async function enumerateCandidates() {
    return classifyAudioDevices(await readDeviceCandidates());
  }

  async function resolveRoute(generation: number): Promise<VirtualAudioRoute | null> {
    let classified = await enumerateCandidates();
    setInputs(classified.inputs);
    setOutputs(classified.outputs);
    if (classified.routes[0]) return classified.routes[0];

    const mediaDevices = navigator.mediaDevices as SelectableMediaDevices;
    if (classified.unpairedVirtualInputs.length > 0 && mediaDevices.selectAudioOutput) {
      setMessage("已找到虚拟麦克风，请选择对应的虚拟播放端（不要选电脑扬声器）…");
      try {
        const selected = await mediaDevices.selectAudioOutput();
        if (checkGenerationRef.current !== generation) throw new Error("DEVICE_CHECK_CANCELLED");
        classified = await enumerateCandidates();
        setInputs(classified.inputs);
        setOutputs(classified.outputs);
        if (classified.routes[0]) return classified.routes[0];
        const unpaired = classified.unpairedVirtualInputs[0];
        if (unpaired && selected.deviceId) {
          return {
            provider: unpaired.provider,
            label: unpaired.label,
            input: unpaired.input,
            output: selected.label || "所选虚拟播放端",
            inputDeviceId: unpaired.inputDeviceId,
            outputDeviceId: selected.deviceId
          };
        }
      } catch (cause) {
        if (cause instanceof Error && cause.message === "DEVICE_CHECK_CANCELLED") throw cause;
      }
    }

    classified = await enumerateCandidates();
    setInputs(classified.inputs);
    setOutputs(classified.outputs);
    if (classified.routes[0]) return classified.routes[0];
    const unpaired = classified.unpairedVirtualInputs[0];
    const unlabeled = classified.unlabeledOutputs;
    if (unpaired && unlabeled.length > 0) {
      setMessage(`已找到“${unpaired.input}”，正在尝试未标注的播放端…`);
      for (const output of unlabeled) {
        if (checkGenerationRef.current !== generation) throw new Error("DEVICE_CHECK_CANCELLED");
        if (await verifyRouteSignal(unpaired.inputDeviceId, output.deviceId, generation)) {
          return {
            provider: unpaired.provider,
            label: unpaired.label,
            input: unpaired.input,
            output: "虚拟播放端",
            inputDeviceId: unpaired.inputDeviceId,
            outputDeviceId: output.deviceId
          };
        }
      }
    }
    return null;
  }

  async function ensureVirtualAudioInstalled(generation: number): Promise<boolean> {
    const bridge = getManagedObsDesktopBridge();
    if (!bridge) return false;
    setMessage("正在检测已安装的虚拟声卡…");
    const status = await bridge.getPrerequisiteStatus();
    if (checkGenerationRef.current !== generation) throw new Error("DEVICE_CHECK_CANCELLED");
    if (status.virtualAudioInstalled) return false;
    if (!status.virtualAudioDriverStaged && !status.virtualAudioPresentInDriverStore) {
      setMessage("正在下载官方 VB-CABLE…");
      const ensured = await bridge.ensureVirtualAudio();
      if (checkGenerationRef.current !== generation) throw new Error("DEVICE_CHECK_CANCELLED");
      if (!ensured.staged) {
        throw new Error(formatPrerequisiteInstallError(ensured.error));
      }
    }
    setMessage("正在安装 VB-Audio VB-CABLE，Windows 将请求管理员授权…");
    const result = await bridge.installPrerequisite("virtual-audio");
    if (checkGenerationRef.current !== generation) throw new Error("DEVICE_CHECK_CANCELLED");
    if (!result.installed) {
      throw new Error(formatPrerequisiteInstallError(result.error));
    }
    return result.rebootRequired;
  }

  // Silent verification used on mount, device changes and periodic renewal.
  // It never triggers driver downloads or UAC; installation stays button-only.
  async function silentAutoCheck(trigger: "mount" | "devicechange") {
    if (silentCheckRunning || !getManagedObsDesktopBridge()) return;
    if (stateRef.current === "ready") return;
    silentCheckRunning = true;
    const generation = checkGenerationRef.current + 1;
    checkGenerationRef.current = generation;
    updateState("checking");
    setMessage("正在自动检测虚拟声卡线路…");
    const failToIdle = (text: string) => {
      updateState("idle");
      setMessage(text);
    };
    try {
      if (!navigator.mediaDevices?.enumerateDevices || !navigator.mediaDevices?.getUserMedia) {
        failToIdle("当前浏览器不支持音频设备检测，请使用最新版 Edge 或 Chrome。");
        return;
      }
      const candidates = await readDeviceCandidates();
      if (checkGenerationRef.current !== generation) return;
      const classified = classifyAudioDevices(candidates);
      setInputs(classified.inputs);
      setOutputs(classified.outputs);

      const stored = loadVirtualAudioRoute();
      const resolvedStored = stored ? resolvePreferredVirtualAudioRoute(stored, candidates) : null;
      if (resolvedStored) {
        if (await verifyRouteSignal(resolvedStored.inputDeviceId, resolvedStored.outputDeviceId, generation)) {
          applyReady(resolvedStored, true);
          return;
        }
        if (checkGenerationRef.current !== generation) return;
      }

      const status = await getManagedObsDesktopBridge()?.getPrerequisiteStatus();
      if (checkGenerationRef.current !== generation) return;
      if (!status?.virtualAudioInstalled) {
        failToIdle(DEFAULT_IDLE_MESSAGE);
        return;
      }

      const permissionStream = await requestAudioStream({ audio: true }, generation);
      permissionStream.getTracks().forEach((track) => track.stop());
      if (checkGenerationRef.current !== generation) return;
      const route = await resolveRoute(generation);
      if (!route) {
        failToIdle(
          trigger === "devicechange"
            ? "音频设备列表已变化，自动重验未通过，请点按钮重新检测。"
            : DEFAULT_IDLE_MESSAGE
        );
        return;
      }
      const signalReady = route.output === "虚拟播放端"
        ? true
        : await verifyRouteSignal(route.inputDeviceId, route.outputDeviceId, generation);
      if (checkGenerationRef.current !== generation) return;
      if (!signalReady) {
        failToIdle("自动检测到设备配对，但线路没有通过信号实测，请点按钮重新检测。");
        return;
      }
      applyReady(route, true);
    } catch (cause) {
      if (cause instanceof Error && cause.message === "DEVICE_CHECK_CANCELLED") return;
      if (checkGenerationRef.current !== generation) return;
      if (cause instanceof DOMException && (cause.name === "NotAllowedError" || cause.name === "SecurityError")) {
        updateState("denied");
        setMessage("Windows 已阻止麦克风访问。请打开隐私设置，开启麦克风访问和桌面应用访问后重试。");
      } else {
        failToIdle(DEFAULT_IDLE_MESSAGE);
      }
    } finally {
      silentCheckRunning = false;
    }
  }

  async function renewVerification() {
    if (silentCheckRunning || stateRef.current !== "ready") return;
    const generation = checkGenerationRef.current + 1;
    checkGenerationRef.current = generation;
    const stored = loadVirtualAudioRoute();
    try {
      if (!stored || !navigator.mediaDevices?.enumerateDevices) {
        updateState("idle");
        setMessage("虚拟声卡线路自动复核未通过，请重新检测。");
        return;
      }
      const resolved = resolvePreferredVirtualAudioRoute(stored, await readDeviceCandidates());
      if (checkGenerationRef.current !== generation) return;
      if (!resolved) {
        updateState("idle");
        setMessage("音频设备列表已变化，自动重验未通过，请点按钮重新检测。");
        return;
      }
      const ok = await verifyRouteSignal(resolved.inputDeviceId, resolved.outputDeviceId, generation);
      if (checkGenerationRef.current !== generation) return;
      if (!ok) {
        updateState("idle");
        setMessage("虚拟声卡线路自动复核未通过，请重新检测。");
        return;
      }
      saveVirtualAudioRoute({ ...stored, verifiedAt: Date.now() });
      setReadinessVerification("virtualAudioReady", true);
      scheduleRenewal();
    } catch (cause) {
      if (cause instanceof Error && cause.message === "DEVICE_CHECK_CANCELLED") return;
      if (checkGenerationRef.current !== generation) return;
      updateState("idle");
      setMessage("虚拟声卡线路自动复核未通过，请重新检测。");
    }
  }

  const renewRef = useRef<() => void>(() => undefined);
  renewRef.current = () => { void renewVerification(); };
  const silentRef = useRef<(trigger: "mount" | "devicechange") => void>(() => undefined);
  silentRef.current = (trigger) => { void silentAutoCheck(trigger); };

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    void (async () => {
      const snapshot = getSnapshotReadiness(loadReadinessSnapshot());
      const stored = loadVirtualAudioRoute();
      if (
        snapshot.virtualAudioReady &&
        stored &&
        typeof navigator.mediaDevices?.enumerateDevices === "function"
      ) {
        try {
          const resolved = resolvePreferredVirtualAudioRoute(stored, await readDeviceCandidates());
          if (resolved && stateRef.current !== "ready" && checkGenerationRef.current === 0) {
            readyRef.current = true;
            stateRef.current = "ready";
            setState("ready");
            onReadyChange?.(true);
            setMessage(`${resolved.label} 已检测：请把会议麦克风选为“${resolved.input}”。`);
            scheduleRenewal();
            return;
          }
        } catch {
          // Fall through to the silent check below.
        }
      }
      window.setTimeout(() => {
        if (checkGenerationRef.current === 0 && stateRef.current === "idle") silentRef.current("mount");
      }, AUTO_CHECK_DELAY_MS);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;
    let debounceId: number | null = null;
    const handleDeviceChange = () => {
      if (debounceId !== null) window.clearTimeout(debounceId);
      debounceId = window.setTimeout(() => {
        debounceId = null;
        checkGenerationRef.current += 1;
        if (stateRef.current === "ready") renewRef.current();
        else if (stateRef.current !== "checking") silentRef.current("devicechange");
      }, DEVICE_CHANGE_DEBOUNCE_MS);
    };
    mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => {
      if (debounceId !== null) window.clearTimeout(debounceId);
      mediaDevices.removeEventListener("devicechange", handleDeviceChange);
    };
  }, []);

  useEffect(() => () => {
    checkGenerationRef.current += 1;
    if (renewalTimerRef.current !== null) window.clearTimeout(renewalTimerRef.current);
  }, []);

  async function checkDevices() {
    const generation = checkGenerationRef.current + 1;
    checkGenerationRef.current = generation;
    updateState("checking");
    setMessage("正在读取 Windows 录音设备…");
    try {
      if (!navigator.mediaDevices?.enumerateDevices || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("当前浏览器不支持音频设备检测，请使用最新版 Edge 或 Chrome。");
      }
      const rebootPending = await ensureVirtualAudioInstalled(generation);
      const permissionStream = await requestAudioStream({ audio: true }, generation);
      permissionStream.getTracks().forEach((track) => track.stop());
      if (checkGenerationRef.current !== generation) throw new Error("DEVICE_CHECK_CANCELLED");

      const route = await resolveRoute(generation);
      if (!route) {
        const classified = await enumerateCandidates();
        updateState(rebootPending ? "reboot" : "missing");
        setMessage(
          classified.ignoredRemoteAudio.length > 0
            ? `检测到远控软件音频端点“${classified.ignoredRemoteAudio.join("”或“")}”，` +
              "但它不是已验证的通用音频线，不能作为会议回传门禁。请先安装 VB-Audio VB-CABLE。"
            : rebootPending
              ? "VB-CABLE 已安装，但录音/播放端还没出现。重启电脑后再检测。"
              : classified.unpairedVirtualInputs.length > 0
                ? `已找到虚拟麦克风“${classified.unpairedVirtualInputs[0].input}”，但没有配对到虚拟播放端。请在系统声音设置中确认虚拟扬声器已启用。`
                : "没有检测到受支持的虚拟音频线路。请先点击上方按钮安装 VB-Audio VB-CABLE。"
        );
        return;
      }

      setMessage(`已找到 ${route.label}，正在把测试音送到“${route.output}”并监听“${route.input}”…`);
      const signalReady = route.output === "虚拟播放端"
        ? true
        : await verifyRouteSignal(route.inputDeviceId, route.outputDeviceId, generation);
      if (!signalReady) {
        updateState(rebootPending ? "reboot" : "missing");
        setMessage(
          `设备配对存在，但“${route.input}”没有收到测试语音。` +
          (rebootPending ? "刚完成安装时请重启电脑后再检测。" : "请确认会议软件和系统播放不会占用该线路，然后重试。")
        );
        return;
      }
      applyReady(route, true);
    } catch (cause) {
      if (cause instanceof Error && cause.message === "DEVICE_CHECK_CANCELLED") return;
      if (cause instanceof DOMException && (cause.name === "NotAllowedError" || cause.name === "SecurityError")) {
        updateState("denied");
        setMessage("Windows 已阻止麦克风访问。请打开隐私设置，开启麦克风访问和桌面应用访问后重试。");
      } else {
        updateState("missing");
        setMessage(cause instanceof Error ? cause.message : "无法读取音频设备。");
      }
    }
  }

  async function openMicrophoneSettings() {
    const bridge = (window as typeof window & { aiInterviewerDesktop?: PermissionBridge }).aiInterviewerDesktop;
    if (bridge) await bridge.openMicrophoneSettings();
  }

  const statusLabel = state === "ready"
    ? "设备已就绪"
    : state === "checking"
      ? "检测中"
      : state === "reboot"
        ? "等待重启"
        : "需要配置";

  return (
    <article className="card audioRoute">
      <div className="cardHeading">
        <h2>AI 语音 → 会议麦克风</h2>
        <span className={state === "ready" ? "ready" : ""}>{statusLabel}</span>
      </div>
      <div className={`audioRouteStatus ${state}`}>
        <i>{state === "ready" ? "✓" : "!"}</i>
        <p>{message}</p>
      </div>
      <div className="audioRouteActions">
        <button disabled={state === "checking"} onClick={() => void checkDevices()}>
          {state === "checking" ? "正在授权并检测…" : "一键授权并检测"}
        </button>
        {state === "denied" && <button className="secondary" onClick={() => void openMicrophoneSettings()}>打开 Windows 麦克风权限</button>}
      </div>
      <ol>
        <li>未安装时点上方按钮授权安装；安装后若设备未出现，重启电脑后再检测。</li>
        <li>会议麦克风选 CABLE Output；AI 语音播放到 CABLE Input（中文系统可能显示 CABLE In 16 Ch 或 扬声器 (VB-Audio Virtual Cable)）。</li>
      </ol>
      {(inputs.length > 0 || outputs.length > 0) && (
        <details>
          <summary>本机音频端点（录音 {inputs.length} / 播放 {outputs.length}）</summary>
          <p className="muted">录音端（会议软件选择）</p>
          <ul>{inputs.map((device) => <li key={`input-${device}`}>{device}</li>)}</ul>
          <p className="muted">播放端（AI 语音输出）</p>
          <ul>{outputs.map((device) => <li key={`output-${device}`}>{device}</li>)}</ul>
        </details>
      )}
      <p className="muted">卸载本客户端不会卸载 VB-CABLE。</p>
    </article>
  );
}

function createBeepWav(durationMs = 800, sampleRate = 24_000) {
  const samples = Math.floor(sampleRate * durationMs / 1000);
  const bytes = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(bytes);
  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let index = 0; index < samples; index += 1) {
    const sample = Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 0.35;
    view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, sample)) * 0x7fff, true);
  }
  return new Blob([bytes], { type: "audio/wav" });
}
