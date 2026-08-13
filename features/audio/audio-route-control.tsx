"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { classifyAudioDevices } from "./audio-devices";
import { calculatePcmRms, hasMeaningfulAudioSignal } from "./audio-signal";

type RouteState = "idle" | "checking" | "ready" | "missing" | "denied";

type AudioRouteControlProps = {
  onReadyChange?: (ready: boolean) => void;
};
type PermissionBridge = { openMicrophoneSettings(): Promise<{ opened: boolean }> };

const VERIFICATION_TTL_MS = 5 * 60_000;

export function AudioRouteControl({ onReadyChange }: AudioRouteControlProps) {
  const readyRef = useRef(false);
  const stateRef = useRef<RouteState>("idle");
  const expiryTimerRef = useRef<number | null>(null);
  const checkGenerationRef = useRef(0);
  const [state, setState] = useState<RouteState>("idle");
  const [inputs, setInputs] = useState<string[]>([]);
  const [outputs, setOutputs] = useState<string[]>([]);
  const [message, setMessage] = useState(
    "AI 语音需要独立的虚拟麦克风线路；OBS Virtual Camera 本身只传视频。"
  );

  const updateState = useCallback((next: RouteState) => {
    if (expiryTimerRef.current !== null) {
      window.clearTimeout(expiryTimerRef.current);
      expiryTimerRef.current = null;
    }
    readyRef.current = next === "ready";
    stateRef.current = next;
    setState(next);
    onReadyChange?.(next === "ready");
    if (next === "ready") {
      expiryTimerRef.current = window.setTimeout(() => {
        readyRef.current = false;
        setState("idle");
        setMessage("虚拟音频检测已超过 5 分钟，请在使用前重新检测。");
        onReadyChange?.(false);
      }, VERIFICATION_TTL_MS);
    }
  }, [onReadyChange]);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;
    const handleDeviceChange = () => {
      checkGenerationRef.current += 1;
      if (stateRef.current !== "ready" && stateRef.current !== "checking") return;
      updateState("idle");
      setMessage("音频设备列表已变化，原线路验证已失效，请重新检测。");
    };
    mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => mediaDevices.removeEventListener("devicechange", handleDeviceChange);
  }, [updateState]);

  useEffect(() => () => {
    checkGenerationRef.current += 1;
    if (expiryTimerRef.current !== null) window.clearTimeout(expiryTimerRef.current);
  }, []);

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

  async function verifyRouteSignal(inputDeviceId: string, generation: number) {
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
      const response = await fetch("/api/stage-test-speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "你好，这是虚拟麦克风线路测试。" })
      });
      if (!response.ok) throw new Error("舞台测试语音发送失败");
      const requiredRms = Math.max(0.015, baselineRms * 3 + 0.004);
      const peakRms = await measurePeakRms(analyser, 8_000, generation, requiredRms);
      if (checkGenerationRef.current !== generation) throw new Error("DEVICE_CHECK_CANCELLED");
      return hasMeaningfulAudioSignal(peakRms, baselineRms);
    } finally {
      source.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      await context.close().catch(() => undefined);
    }
  }

  async function checkDevices() {
    const generation = checkGenerationRef.current + 1;
    checkGenerationRef.current = generation;
    updateState("checking");
    setMessage("正在读取 Windows 录音设备…");
    try {
      if (!navigator.mediaDevices?.enumerateDevices || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("当前浏览器不支持音频设备检测，请使用最新版 Edge 或 Chrome。");
      }

      // Device labels stay hidden until the user grants microphone permission.
      const permissionStream = await requestAudioStream({ audio: true }, generation);
      permissionStream.getTracks().forEach((track) => track.stop());
      if (checkGenerationRef.current !== generation) throw new Error("DEVICE_CHECK_CANCELLED");
      const classified = classifyAudioDevices(
        (await navigator.mediaDevices.enumerateDevices())
          .filter((device) => device.kind === "audioinput" || device.kind === "audiooutput")
          .map((device) => ({
            kind: device.kind as "audioinput" | "audiooutput",
            label: device.label,
            deviceId: device.deviceId
          }))
      );
      setInputs(classified.inputs);
      setOutputs(classified.outputs);

      if (classified.routes.length > 0) {
        const route = classified.routes[0];
        setMessage(`已找到 ${route.label}，正在播放测试语音并监听“${route.input}”…`);
        const signalReady = await verifyRouteSignal(route.inputDeviceId, generation);
        if (!signalReady) {
          updateState("missing");
          setMessage(
            `设备配对存在，但“${route.input}”没有收到测试语音。` +
            `请把 OBS 监听设备设为“${route.output}”，并确认舞台源启用了“仅监听”，然后重试。`
          );
          return;
        }
        updateState("ready");
        setMessage(
          `${route.label} 端到端信号通过：OBS 监听输出“${route.output}”已到达会议麦克风“${route.input}”。`
        );
      } else {
        updateState("missing");
        setMessage(
          classified.ignoredRemoteAudio.length > 0
            ? `检测到远控软件音频端点“${classified.ignoredRemoteAudio.join("”或“")}”，` +
              "但它不是已验证的通用音频线，不能作为会议回传门禁。请安装下面任一成对线路。"
            : "没有检测到受支持的成对虚拟音频线路。请先安装下面任一方案，重启电脑后再次检测。"
        );
      }
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

  return (
    <article className="card audioRoute">
      <div className="cardHeading">
        <h2>AI 语音 → 会议麦克风</h2>
        <span className={state === "ready" ? "ready" : ""}>
          {state === "ready" ? "设备已就绪" : state === "checking" ? "检测中" : "需要配置"}
        </span>
      </div>
      <div className={`audioRouteStatus ${state}`}>
        <i>{state === "ready" ? "✓" : "!"}</i>
        <p>{message}</p>
      </div>
      <div className="audioRouteActions">
        <button disabled={state === "checking"} onClick={checkDevices}>
          {state === "checking" ? "正在授权并检测…" : "一键授权并检测"}
        </button>
        {state === "denied" && <button className="secondary" onClick={() => void openMicrophoneSettings()}>打开 Windows 麦克风权限</button>}
      </div>
      <ol>
        <li>客户端安装器已内置签名虚拟声卡，无需另行下载。</li>
        <li>会议软件把麦克风选为安装器创建的虚拟线路录音端。</li>
        <li>点击测试并确认会议软件的麦克风音量条有波动。</li>
      </ol>
      {(inputs.length > 0 || outputs.length > 0) && (
        <details>
          <summary>本机音频端点（录音 {inputs.length} / 播放 {outputs.length}）</summary>
          <p className="muted">录音端（会议软件选择）</p>
          <ul>{inputs.map((device) => <li key={`input-${device}`}>{device}</li>)}</ul>
          <p className="muted">播放端（OBS 监听设备选择）</p>
          <ul>{outputs.map((device) => <li key={`output-${device}`}>{device}</li>)}</ul>
        </details>
      )}
      <p className="muted">
        若显示“等待重启”，请重启 Windows 后再检测；签名或系统策略阻止时请联系管理员。
      </p>
    </article>
  );
}
