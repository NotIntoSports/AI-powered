"use client";

import { useEffect, useRef, useState } from "react";
import { classifyAudioDevices } from "./audio-devices";

type SelectableMediaDevices = MediaDevices & {
  selectAudioOutput?: (options?: { deviceId?: string }) => Promise<MediaDeviceInfo>;
};

type SinkAudioElement = HTMLAudioElement & {
  setSinkId?: (deviceId: string) => Promise<void>;
};

type HumanTakeoverControlProps = {
  disabled: boolean;
  onBeforeStart: () => void;
  onActiveChange: (active: boolean) => void;
};

export function HumanTakeoverControl({
  disabled,
  onBeforeStart,
  onActiveChange
}: HumanTakeoverControlProps) {
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<SinkAudioElement | null>(null);
  const [active, setActive] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState(
    "接管后会暂停 AI，并把本机默认麦克风直接送入会议软件正在使用的虚拟麦克风线路。"
  );

  function releaseBridge() {
    audioRef.current?.pause();
    if (audioRef.current) audioRef.current.srcObject = null;
    audioRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  function stop() {
    releaseBridge();
    setActive(false);
    onActiveChange(false);
    setMessage("人工接管已结束。恢复 AI 前请确认虚拟音频线路仍然可用。 ");
  }

  useEffect(() => () => releaseBridge(), []);
  useEffect(() => {
    if (disabled && active) stop();
  }, [disabled, active]);

  async function chooseVirtualOutput() {
    const mediaDevices = navigator.mediaDevices as SelectableMediaDevices;
    if (mediaDevices.selectAudioOutput) {
      return mediaDevices.selectAudioOutput();
    }
    const devices = await mediaDevices.enumerateDevices();
    const route = classifyAudioDevices(devices
      .filter((device) => device.kind === "audioinput" || device.kind === "audiooutput")
      .map((device) => ({
        kind: device.kind as "audioinput" | "audiooutput",
        label: device.label,
        deviceId: device.deviceId
      }))).routes[0];
    if (!route) throw new Error("当前浏览器无法选择输出设备，也没有找到已授权的虚拟音频线路。请使用最新版 Edge 或 Chrome。");
    return { deviceId: route.outputDeviceId, label: route.output } as MediaDeviceInfo;
  }

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMessage("当前浏览器不支持麦克风接管，请使用最新版 Edge 或 Chrome。");
      return;
    }
    setWorking(true);
    setMessage("请选择虚拟音频线路的播放端，例如 CABLE Input，而不是电脑扬声器。");
    try {
      const output = await chooseVirtualOutput();
      onBeforeStart();
      await fetch("/api/stage-status", { method: "PUT" });
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });
      const audio = new Audio() as SinkAudioElement;
      if (!audio.setSinkId) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("当前浏览器不能把声音定向到虚拟音频设备，请使用最新版 Edge 或 Chrome。");
      }
      await audio.setSinkId(output.deviceId);
      audio.srcObject = stream;
      audio.autoplay = true;
      streamRef.current = stream;
      audioRef.current = audio;
      stream.getAudioTracks()[0]?.addEventListener("ended", stop, { once: true });
      await audio.play();
      setActive(true);
      onActiveChange(true);
      setMessage(`人工接管中：你的麦克风正在发送到“${output.label || "所选虚拟音频设备"}”。`);
    } catch (cause) {
      releaseBridge();
      setActive(false);
      onActiveChange(false);
      const name = cause instanceof DOMException ? cause.name : "";
      setMessage(
        name === "NotAllowedError"
          ? "已取消设备授权，未进入人工接管。"
          : cause instanceof Error ? cause.message : "无法启用人工接管。"
      );
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className={`humanTakeover ${active ? "active" : ""}`} aria-live="polite">
      <div>
        <strong>{active ? "人工接管中" : "人工接管"}</strong>
        <p>{message}</p>
      </div>
      {active ? (
        <button type="button" className="danger" onClick={stop}>结束接管并恢复 AI 控制</button>
      ) : (
        <button type="button" disabled={disabled || working} onClick={() => void start()}>
          {working ? "正在连接麦克风…" : "暂停 AI，由我直接对话"}
        </button>
      )}
    </section>
  );
}
