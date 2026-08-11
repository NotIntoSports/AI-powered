"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { classifyAudioDevices } from "./audio-devices";
import { calculatePcmRms, hasMeaningfulAudioSignal } from "./audio-signal";

type RouteState = "idle" | "checking" | "ready" | "missing" | "denied";

type AudioRouteControlProps = {
  onReadyChange?: (ready: boolean) => void;
};

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
        setMessage("虚拟音频检测已超过 5 分钟，请在面试前重新检测。");
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
        setMessage("未获得麦克风设备读取权限；请允许本页面使用麦克风后重试。");
      } else {
        updateState("missing");
        setMessage(cause instanceof Error ? cause.message : "无法读取音频设备。");
      }
    }
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
          {state === "checking" ? "正在检测…" : "检测虚拟麦克风"}
        </button>
        <a
          href="https://github.com/VirtualDrivers/Virtual-Audio-Driver/releases"
          target="_blank"
          rel="noreferrer"
        >
          开源驱动（MIT）
        </a>
        <a href="https://vb-audio.com/Cable/" target="_blank" rel="noreferrer">
          成熟兜底（VB-CABLE）
        </a>
      </div>
      <ol>
        <li>安装虚拟音频驱动并按安装提示重启。</li>
        <li>OBS 设置 → 音频 → 高级，将“监听设备”选为虚拟线路的播放端（如 CABLE Input）。</li>
        <li>会议软件把麦克风选为虚拟线路的录音端（如 CABLE Output）。</li>
        <li>点击“播放测试语音”，确认会议软件的麦克风音量条有波动。</li>
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
        开源驱动仍处于较早阶段；企业机器若不允许安装驱动，请让 IT 安装批准的虚拟音频设备。
      </p>
    </article>
  );
}
