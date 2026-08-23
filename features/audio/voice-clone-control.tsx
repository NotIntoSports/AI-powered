"use client";

import { useEffect, useRef, useState } from "react";
import { isUnwantedCloneMicrophone, pickCloneMicrophone } from "./audio-devices";
import {
  CLONE_MAX_SECONDS,
  CLONE_MIN_SECONDS,
  CLONE_SAMPLE_RATE,
  cloneDurationStatus,
  concatFloat32,
  downsampleToRate,
  encodePcm16Wav
} from "../../lib/pcm-wav";
import { DEFAULT_CUSTOM_SPEAKER_ID, VOICE_CLONE_SCRIPT } from "../../lib/voice-clone-script";
import { clonedVoicePreviewMessage } from "../../lib/cloned-voice-tts-error";

type VoiceCloneStatus = {
  available: boolean;
  aliyunCloneReady?: boolean;
  ttsAvailable: boolean;
  speakerId: string;
  provider?: string;
  cloned?: boolean;
  enabled?: boolean;
  voiceAllocationStatus?: "unallocated" | "allocating" | "allocated";
};

function isCosyVoiceId(speakerId: string) {
  return speakerId.trim().toLowerCase().startsWith("cosyvoice-");
}

export function VoiceCloneControl() {
  const [status, setStatus] = useState<VoiceCloneStatus>({
    available: false,
    ttsAvailable: false,
    speakerId: "",
    provider: "none",
    cloned: false,
    enabled: false
  });
  const [pastedId, setPastedId] = useState("");
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [previewUrl, setPreviewUrl] = useState("");
  const [audioBase64, setAudioBase64] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [messageKind, setMessageKind] = useState<"info" | "success" | "error">("info");
  const [message, setMessage] = useState("按稿朗读 15–20 秒。使用本机真实麦克风，不要选虚拟线路。");
  const chunksRef = useRef<Float32Array[]>([]);
  const contextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const timerRef = useRef<number>(0);
  const startedAtRef = useRef(0);

  useEffect(() => {
    void refreshStatus();
    return () => stopTracks();
  }, []);

  async function refreshStatus(preserveSpeakerId = "") {
    try {
      const response = await fetch("/api/voice-clone", { cache: "no-store" });
      const data = await response.json() as VoiceCloneStatus;
      const speakerId = String(data.speakerId || preserveSpeakerId || "");
      setStatus({
        available: Boolean(data.available),
        aliyunCloneReady: Boolean(data.aliyunCloneReady),
        ttsAvailable: Boolean(data.ttsAvailable || speakerId),
        speakerId,
        provider: String(data.provider || (speakerId ? (isCosyVoiceId(speakerId) ? "aliyun" : "volcengine") : "")),
        cloned: Boolean(data.cloned || speakerId),
        enabled: Boolean(data.enabled || speakerId),
        voiceAllocationStatus: speakerId ? "allocated" : (data.voiceAllocationStatus || "unallocated")
      });
      if (speakerId) setPastedId(speakerId);
    } catch {
      setStatus({ available: false, ttsAvailable: false, speakerId: "", provider: "none", cloned: false, enabled: false });
    }
  }

  function stopTracks() {
    window.clearInterval(timerRef.current);
    processorRef.current?.disconnect();
    processorRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void contextRef.current?.close().catch(() => undefined);
    contextRef.current = null;
  }

  async function startRecording() {
    if (status.voiceAllocationStatus !== "unallocated") return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setMessage("当前浏览器不支持麦克风录音，请使用最新版 Edge 或 Chrome。");
      return;
    }
    stopTracks();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl("");
    setAudioBase64("");
    chunksRef.current = [];
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then((stream) => {
        stream.getTracks().forEach((track) => track.stop());
      });
      const devices = await navigator.mediaDevices.enumerateDevices();
      const picked = pickCloneMicrophone(devices
        .filter((device) => device.kind === "audioinput")
        .map((device) => ({
          kind: "audioinput" as const,
          label: device.label,
          deviceId: device.deviceId
        })));
      if (!picked) {
        setMessage("没有找到可用的真实麦克风。请避开 VB-CABLE、虚拟麦克风和远程音频设备。");
        return;
      }
      if (isUnwantedCloneMicrophone(picked.label)) {
        setMessage("请改用真实麦克风，不要录虚拟线路。");
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: picked.deviceId },
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });
      const context = new AudioContext({ sampleRate: CLONE_SAMPLE_RATE });
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const mute = context.createGain();
      mute.gain.value = 0;
      processor.onaudioprocess = (event) => {
        chunksRef.current.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(mute);
      mute.connect(context.destination);
      streamRef.current = stream;
      contextRef.current = context;
      processorRef.current = processor;
      startedAtRef.current = Date.now();
      setRecording(true);
      setSeconds(0);
      setMessage(`正在录音：${picked.label}。请按稿自然朗读。`);
      timerRef.current = window.setInterval(() => {
        const elapsed = (Date.now() - startedAtRef.current) / 1000;
        setSeconds(elapsed);
        if (elapsed >= CLONE_MAX_SECONDS) void stopRecording();
      }, 200);
    } catch (cause) {
      stopTracks();
      const name = cause instanceof DOMException ? cause.name : "";
      setMessage(name === "NotAllowedError" ? "未获得麦克风权限。" : "无法开始录音。");
    }
  }

  async function stopRecording() {
    if (!recording && !streamRef.current) return;
    setRecording(false);
    window.clearInterval(timerRef.current);
    const context = contextRef.current;
    const sampleRate = context?.sampleRate || CLONE_SAMPLE_RATE;
    const samples = downsampleToRate(concatFloat32(chunksRef.current), sampleRate, CLONE_SAMPLE_RATE);
    stopTracks();
    const duration = samples.length / CLONE_SAMPLE_RATE;
    const status = cloneDurationStatus(duration);
    if (status === "too-short") {
      setAudioBase64("");
      setMessage(`录音约 ${duration.toFixed(1)} 秒，至少需要 ${CLONE_MIN_SECONDS} 秒。请按稿再录一次。`);
      return;
    }
    const wav = encodePcm16Wav(samples, CLONE_SAMPLE_RATE);
    const blob = new Blob([wav], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    setPreviewUrl(url);
    setAudioBase64(bufferToBase64(wav));
    setSeconds(Math.min(duration, CLONE_MAX_SECONDS));
    setMessage(status === "too-long" ? "已截取前 25 秒，可以试听后提交刻录。" : "录音完成，可以试听后提交刻录。");
  }

  async function cloneVoice() {
    if (status.voiceAllocationStatus !== "unallocated") {
      setMessage("音色已分配，每个账号仅可分配一次。");
      return;
    }
    if (!audioBase64) {
      setMessage("请先录一段 8–25 秒的朗读。");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/voice-clone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioBase64,
          format: "wav",
          speakerId: pastedId.trim() || DEFAULT_CUSTOM_SPEAKER_ID
        })
      });
      const data = await response.json() as {
        speakerId?: string;
        message?: string;
        code?: string;
        bound?: boolean;
        enabled?: boolean;
      };
      if (!response.ok) {
        if (data.code === "VOICE_ALREADY_ALLOCATED" || data.code === "VOICE_ALLOCATION_IN_PROGRESS") {
          setMessageKind("error");
          setMessage(data.message || "音色已分配或正在分配，请勿重复提交。");
          await refreshStatus();
          return;
        }
        if (data.code === "VOICE_BIND_FAILED") {
          const speakerId = String(data.speakerId || "");
          if (speakerId) {
            setStatus((current) => ({
              ...current,
              speakerId,
              ttsAvailable: true,
              cloned: true,
              enabled: false,
              provider: "volcengine"
            }));
            setPastedId(speakerId);
          }
          setMessageKind("error");
          setMessage(data.message || "刻录完成，但账号同步失败，请确认已登录桌面账号后再保存音色 ID。");
          await refreshStatus(speakerId);
          return;
        }
        setMessageKind("error");
        setMessage(data.message || "声音刻录失败。");
        return;
      }
      const speakerId = String(data.speakerId || "");
      setStatus((current) => ({
        ...current,
        speakerId,
        ttsAvailable: Boolean(speakerId),
        cloned: Boolean(speakerId),
        enabled: Boolean(data.enabled ?? data.bound ?? speakerId),
        provider: speakerId ? (isCosyVoiceId(speakerId) ? "aliyun" : "volcengine") : current.provider
      }));
      setPastedId(speakerId);
      setMessageKind("success");
      setMessage(
        !speakerId
          ? "刻录成功，已绑定本账号。"
          : isCosyVoiceId(speakerId)
            ? "刻录成功，已自动为你分配专属音色，可点试听。"
            : "刻录成功，已启用本账号专属音色。"
      );
      await refreshStatus(speakerId);
    } catch {
      setMessageKind("error");
      setMessage("声音刻录失败，请检查网络和语音配置。");
    } finally {
      setBusy(false);
    }
  }

  async function savePastedId() {
    const speakerId = pastedId.trim();
    if (!speakerId) {
      setMessage("请填写已有音色 ID。");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/voice-clone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speakerId })
      });
      const data = await response.json() as {
        speakerId?: string;
        message?: string;
        code?: string;
        bound?: boolean;
      };
      if (!response.ok) {
        setMessage(
          data.code === "VOICE_BIND_FAILED"
            ? (data.message || "账号音色同步失败，请确认已登录桌面账号。")
            : (data.message || "无法保存音色 ID。")
        );
        return;
      }
      setStatus((current) => ({
        ...current,
        speakerId: String(data.speakerId || speakerId),
        ttsAvailable: true,
        cloned: true,
        enabled: true,
        provider: "volcengine"
      }));
      setMessageKind("success");
      setMessage("已启用本账号专属音色，可点试听。");
      await refreshStatus(String(data.speakerId || speakerId));
    } catch {
      setMessage("无法保存音色 ID。");
    } finally {
      setBusy(false);
    }
  }

  async function previewTts() {
    setTesting(true);
    try {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "你好，我是今天的虚拟助手，现在用复刻音色试听。" })
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { code?: string } | null;
        setMessage(
          failure?.code === "CLONED_VOICE_QUOTA_EXPIRED" || failure?.code === "CLONED_VOICE_UNAVAILABLE"
            ? clonedVoicePreviewMessage(failure.code)
            : "试听失败。若尚未刻录，请先录音；也可检查 Windows 中文语音。"
        );
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
      setMessage("正在播放复刻音色试听。");
    } catch {
      setMessage("试听失败。");
    } finally {
      setTesting(false);
    }
  }

  return (
    <article className="card voiceClone">
      <div className="cardHeading">
        <h2>助手声音刻录</h2>
        <span className={status.cloned || status.enabled ? "ready" : ""}>
          {status.voiceAllocationStatus === "allocating"
            ? "音色正在分配，请勿重复提交"
            : status.voiceAllocationStatus === "allocated"
              ? "已启用你的专属音色"
            : status.cloned && status.speakerId
            ? "已启用你的专属音色"
            : status.provider === "aliyun"
              ? "阿里云语音已配置，待刻录（将自动分配专属音色）"
              : status.available
                ? "密钥已就绪，待刻录（将绑定当前登录账号）"
                : "请先在管理后台配置豆包语音，或在本机配置阿里云语音"}
        </span>
      </div>
      {status.voiceAllocationStatus === "allocated" ? (
        <>
          <p className="voiceCloneTips">音色已分配，每个账号仅可分配一次。你可以继续试听当前专属音色。</p>
          <div className="voiceCloneActions">
            <button className="secondary" type="button" disabled={testing} onClick={() => void previewTts()}>
              {testing ? "试听中…" : "试听 TTS"}
            </button>
          </div>
          <p className={`modelSettingsMessage ${messageKind === "success" ? "voiceCloneSuccess" : ""}`} aria-live="polite">{message}</p>
        </>
      ) : status.voiceAllocationStatus === "allocating" ? (
        <p className="modelSettingsMessage" aria-live="polite">音色分配结果正在确认。为避免重复占用音色位置，本账号暂不能再次提交刻录。</p>
      ) : <>
      <p className="voiceCloneTips">安静环境、用真实麦克风、语速自然，不要念成播音腔。朗读稿不可改，以保证复刻质量。</p>
      <blockquote className="voiceCloneScript">{VOICE_CLONE_SCRIPT}</blockquote>
      <p className="fileMeta">已录 {seconds.toFixed(1)} 秒 · 有效范围 {CLONE_MIN_SECONDS}–{CLONE_MAX_SECONDS} 秒</p>
      <div className="voiceCloneActions">
        {!recording ? (
          <button type="button" disabled={busy} onClick={() => void startRecording()}>开始录音</button>
        ) : (
          <button type="button" onClick={() => void stopRecording()}>停止录音</button>
        )}
        <button type="button" disabled={busy || !audioBase64} onClick={() => void cloneVoice()}>
          {busy ? "正在刻录…" : "提交刻录"}
        </button>
        <button className="secondary" type="button" disabled={testing} onClick={() => void previewTts()}>
          {testing ? "试听中…" : "试听 TTS"}
        </button>
      </div>
      {previewUrl ? <audio className="voiceClonePreview" src={previewUrl} controls /> : null}
      <details className="voiceCloneAdvanced">
        <summary>高级选项（已有音色 ID）</summary>
        <label>
          已有音色 ID（可粘贴 S_xxxx，跳过录音）
          <input value={pastedId} onChange={(event) => setPastedId(event.target.value)} placeholder={DEFAULT_CUSTOM_SPEAKER_ID} />
        </label>
        <button className="secondary" type="button" disabled={busy} onClick={() => void savePastedId()}>保存音色 ID</button>
      </details>
      <p className={`modelSettingsMessage ${messageKind === "success" ? "voiceCloneSuccess" : ""}`} aria-live="polite">{message}</p>
      </>}
    </article>
  );
}

function bufferToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
