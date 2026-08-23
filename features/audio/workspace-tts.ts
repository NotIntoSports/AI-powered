"use client";

import { useEffect, useRef } from "react";
import type { InterviewSession } from "../../lib/interview";
import { emitPipelineEvent } from "../diagnostics/pipeline-log";
import { requireVirtualTtsSink, shouldSynthesizeSessionSpeech } from "./tts-output-policy";
import { loadLocalAiMonitorEnabled, subscribeLocalAiMonitor } from "./local-ai-monitor";
import { loadAiReferenceModeEnabled, subscribeAiReferenceMode } from "./ai-reference-mode";
import {
  loadVirtualAudioRoute,
  resolveStoredRouteAgainstDevices
} from "./virtual-audio-route";

type SinkAudioElement = HTMLAudioElement & {
  setSinkId?: (deviceId: string) => Promise<void>;
};

type TtsState = "idle" | "speaking" | "ready" | "error";

const errorMessages: Record<string, string> = {
  VIRTUAL_AUDIO_ROUTE_NOT_READY: "AI 声音未送入会议麦克风：请在设置中完成 VB-CABLE 线路检测。",
  SET_SINK_ID_UNSUPPORTED: "AI 声音未送入会议麦克风：当前播放环境不支持选择 VB-CABLE 输出。",
  SET_SINK_ID_FAILED: "AI 声音未送入会议麦克风：VB-CABLE 播放端选择失败，请重新检测线路。",
  AUDIO_PLAYBACK_FAILED: "AI 声音未送入会议麦克风：音频播放失败，请检查 VB-CABLE。",
  TTS_REQUEST_FAILED: "AI 声音未送入会议麦克风：语音合成服务请求失败。",
  CLONED_VOICE_QUOTA_EXPIRED: "复刻音色服务额度已过期，请管理员续费后重试；本轮未播放默认音色。",
  CLONED_VOICE_UNAVAILABLE: "复刻音色合成失败；本轮未播放备用音色。"
};

async function resolveVirtualAudioSinkId(): Promise<string | null> {
  const route = loadVirtualAudioRoute();
  if (!route?.outputDeviceId) return null;
  try {
    const devices = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
    const resolved = resolveStoredRouteAgainstDevices(
      route,
      devices.map((device) => ({
        kind: device.kind as "audioinput" | "audiooutput",
        label: device.label,
        deviceId: device.deviceId
      }))
    );
    return resolved?.outputDeviceId ?? null;
  } catch {
    return null;
  }
}

export function useWorkspaceTts(input: {
  session: InterviewSession;
  sessionLoaded: boolean;
}) {
  const initializedRef = useRef(false);
  const lastRevisionRef = useRef(-1);
  const lastTestSpeechIdRef = useRef(0);
  const tokenRef = useRef(0);
  const virtualAudioRef = useRef<HTMLAudioElement | null>(null);
  const localMonitorAudioRef = useRef<HTMLAudioElement | null>(null);
  const localMonitorEnabledRef = useRef(true);
  const aiReferenceModeRef = useRef(false);
  const audioUrlRef = useRef("");
  const stateRef = useRef<{ state: TtsState; error: string; lastSpeechAt: number }>({
    state: "idle",
    error: "",
    lastSpeechAt: 0
  });

  function releaseAudio() {
    virtualAudioRef.current?.pause();
    localMonitorAudioRef.current?.pause();
    virtualAudioRef.current = null;
    localMonitorAudioRef.current = null;
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = "";
    }
  }

  function updateState(state: TtsState, error = "", lastSpeechAt = stateRef.current.lastSpeechAt) {
    stateRef.current = { state, error, lastSpeechAt };
    void reportStatus();
  }

  async function reportStatus() {
    const setSinkSupported = typeof HTMLMediaElement !== "undefined" &&
      typeof (HTMLMediaElement.prototype as SinkAudioElement).setSinkId === "function";
    await fetch("/api/stage-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ttsSupported: setSinkSupported,
        voiceCount: 0,
        ttsState: stateRef.current.state,
        ttsError: stateRef.current.error,
        lastSpeechAt: stateRef.current.lastSpeechAt,
        mediaReady: true
      })
    }).catch(() => undefined);
  }

  function stopPlayback() {
    tokenRef.current += 1;
    releaseAudio();
    updateState("idle");
  }

  async function fail(traceId: string, code: string) {
    const message = errorMessages[code] || errorMessages.AUDIO_PLAYBACK_FAILED;
    updateState("error", message);
    await emitPipelineEvent({
      event: "tts.playback-failed",
      traceId,
      fields: { code, mode: "virtual" }
    });
  }

  async function playSpeech(text: string, traceId: string) {
    const token = tokenRef.current + 1;
    tokenRef.current = token;
    releaseAudio();

    const sinkId = await resolveVirtualAudioSinkId();
    const setSinkSupported = typeof HTMLMediaElement !== "undefined" &&
      typeof (HTMLMediaElement.prototype as SinkAudioElement).setSinkId === "function";
    const decision = requireVirtualTtsSink({ sinkId, setSinkSupported });
    void emitPipelineEvent({
      event: "tts.sink-resolved",
      traceId,
      fields: { sinkResolved: decision.ok, mode: "virtual" }
    });
    if (!decision.ok) {
      await fail(traceId, decision.code);
      return;
    }

    try {
      void emitPipelineEvent({ event: "tts.stage-requested", traceId, fields: { textLength: text.length } });
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, traceId })
      });
      void emitPipelineEvent({
        event: "tts.stage-response",
        traceId,
        fields: { httpStatus: response.status, status: response.ok ? "ok" : "failed" }
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { code?: string } | null;
        const code = failure?.code === "CLONED_VOICE_QUOTA_EXPIRED" || failure?.code === "CLONED_VOICE_UNAVAILABLE"
          ? failure.code
          : "TTS_REQUEST_FAILED";
        await fail(traceId, code);
        return;
      }
      if (tokenRef.current !== token) return;

      const url = URL.createObjectURL(await response.blob());
      audioUrlRef.current = url;
      const audio = new Audio(url) as SinkAudioElement;
      try {
        await audio.setSinkId!(decision.sinkId);
      } catch (cause) {
        void emitPipelineEvent({
          event: "tts.sink-failed",
          traceId,
          fields: { code: cause instanceof Error ? cause.name : "UNKNOWN", mode: "virtual" }
        });
        releaseAudio();
        await fail(traceId, "SET_SINK_ID_FAILED");
        return;
      }
      void emitPipelineEvent({
        event: "tts.sink-selected",
        traceId,
        fields: { sinkResolved: true, mode: "virtual" }
      });
      if (tokenRef.current !== token) {
        releaseAudio();
        return;
      }

      virtualAudioRef.current = audio;
      const localMonitorAudio = localMonitorEnabledRef.current ? new Audio(url) : null;
      localMonitorAudioRef.current = localMonitorAudio;
      audio.onplay = () => {
        if (tokenRef.current !== token) return;
        updateState("speaking");
        void emitPipelineEvent({ event: "tts.playback-started", traceId, fields: { mode: "virtual" } });
      };
      audio.onended = () => {
        if (tokenRef.current !== token) return;
        const endedAt = Date.now();
        releaseAudio();
        updateState("ready", "", endedAt);
        void emitPipelineEvent({
          event: "tts.playback-ended",
          traceId,
          fields: { mode: "virtual", status: "ready" }
        });
      };
      audio.onerror = () => {
        if (tokenRef.current !== token) return;
        releaseAudio();
        void fail(traceId, "AUDIO_PLAYBACK_FAILED");
      };
      await audio.play();
      if (tokenRef.current !== token || !localMonitorAudio) return;
      localMonitorAudio.onplay = () => {
        if (tokenRef.current !== token) return;
        void emitPipelineEvent({
          event: "tts.playback-started",
          traceId,
          fields: { mode: "local-monitor" }
        });
      };
      localMonitorAudio.onended = () => {
        if (tokenRef.current !== token) return;
        localMonitorAudioRef.current = null;
        void emitPipelineEvent({
          event: "tts.playback-ended",
          traceId,
          fields: { mode: "local-monitor", status: "ready" }
        });
      };
      localMonitorAudio.onerror = () => {
        if (tokenRef.current !== token) return;
        localMonitorAudioRef.current = null;
        void emitPipelineEvent({
          event: "tts.playback-failed",
          traceId,
          fields: { code: "LOCAL_AUDIO_PLAYBACK_FAILED", mode: "local-monitor" }
        });
      };
      void localMonitorAudio.play().catch((cause) => {
        if (tokenRef.current !== token) return;
        localMonitorAudioRef.current = null;
        void emitPipelineEvent({
          event: "tts.playback-failed",
          traceId,
          fields: {
            code: cause instanceof Error ? cause.name : "LOCAL_AUDIO_PLAYBACK_FAILED",
            mode: "local-monitor"
          }
        });
      });
    } catch {
      if (tokenRef.current !== token) return;
      releaseAudio();
      await fail(traceId, "AUDIO_PLAYBACK_FAILED");
    }
  }

  useEffect(() => {
    localMonitorEnabledRef.current = loadLocalAiMonitorEnabled();
    return subscribeLocalAiMonitor(() => {
      localMonitorEnabledRef.current = loadLocalAiMonitorEnabled();
      if (!localMonitorEnabledRef.current) {
        localMonitorAudioRef.current?.pause();
        localMonitorAudioRef.current = null;
      }
    });
  }, []);

  useEffect(() => {
    aiReferenceModeRef.current = loadAiReferenceModeEnabled();
    return subscribeAiReferenceMode(() => {
      aiReferenceModeRef.current = loadAiReferenceModeEnabled();
      if (aiReferenceModeRef.current) stopPlayback();
    });
  }, []);

  useEffect(() => {
    if (!input.sessionLoaded) return;
    if (!initializedRef.current) {
      initializedRef.current = true;
      lastRevisionRef.current = input.session.revision;
      return;
    }
    if (
      input.session.revision <= lastRevisionRef.current ||
      !input.session.speakingText
    ) return;
    lastRevisionRef.current = input.session.revision;
    if (!shouldSynthesizeSessionSpeech({
      referenceMode: aiReferenceModeRef.current,
      text: input.session.speakingText
    })) return;
    void emitPipelineEvent({
      event: "tts.speech-detected",
      traceId: input.session.sessionId,
      fields: { revision: input.session.revision, textLength: input.session.speakingText.length }
    });
    void playSpeech(input.session.speakingText, input.session.sessionId || "workspace");
  }, [input.session, input.sessionLoaded]);

  useEffect(() => {
    const handleIntervention = (event: Event) => {
      const action = (event as CustomEvent<{ action?: string }>).detail?.action;
      if (action === "begin" || action === "mute") stopPlayback();
    };
    window.addEventListener("ai-intervention", handleIntervention);
    return () => window.removeEventListener("ai-intervention", handleIntervention);
  }, []);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const response = await fetch("/api/stage-test-speech", { cache: "no-store" });
        const speech = await response.json() as { id: number; text: string; createdAt: number } | null;
        if (
          active && speech && speech.id > lastTestSpeechIdRef.current &&
          Date.now() - speech.createdAt < 10_000
        ) {
          lastTestSpeechIdRef.current = speech.id;
          void playSpeech(speech.text, "stage-test");
        }
      } catch {
        // The next polling cycle will retry while the desktop server is available.
      }
    };
    void poll();
    const timer = window.setInterval(poll, 600);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    void reportStatus();
    const timer = window.setInterval(reportStatus, 3_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => () => stopPlayback(), []);
}
