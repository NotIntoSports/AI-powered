"use client";

import { useEffect, useRef, useState } from "react";
import type { InterviewSession } from "../../lib/interview";

type AvatarMetadata = {
  available: boolean;
  kind?: "image" | "video";
  version?: string;
};

export default function StagePage() {
  const lastRevision = useRef(-1);
  const lastTestSpeechId = useRef(0);
  const speechToken = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef("");
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [avatarMedia, setAvatarMedia] = useState<AvatarMetadata>({ available: false });
  const [speaking, setSpeaking] = useState(false);
  const [currentSpeechText, setCurrentSpeechText] = useState("");
  const [ttsState, setTtsState] = useState<"idle" | "speaking" | "ready" | "error">("idle");
  const [ttsError, setTtsError] = useState("");
  const [lastSpeechAt, setLastSpeechAt] = useState(0);
  const [mediaReady, setMediaReady] = useState(true);
  const playbackBlocked = ttsState === "error" && /not.?allowed/i.test(ttsError);

  function releaseAudio() {
    audioRef.current?.pause();
    audioRef.current = null;
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = "";
    }
  }

  function playWebSpeech(text: string, token: number, precedingError: string) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    utterance.rate = 0.92;
    utterance.pitch = 1;
    utterance.onstart = () => {
      if (speechToken.current !== token) return;
      setTtsError("");
      setTtsState("speaking");
      setSpeaking(true);
    };
    utterance.onend = () => {
      if (speechToken.current !== token) return;
      setSpeaking(false);
      setTtsState("ready");
      setLastSpeechAt(Date.now());
    };
    utterance.onerror = (event) => {
      if (speechToken.current !== token) return;
      setSpeaking(false);
      setTtsState("error");
      setTtsError(`${precedingError}; web-speech:${event.error || "unknown"}`);
    };
    window.speechSynthesis.speak(utterance);
  }

  async function playSpeech(text: string, token: number) {
    setCurrentSpeechText(text);
    releaseAudio();
    window.speechSynthesis.cancel();
    let fallbackStarted = false;
    const fallback = (reason: string) => {
      if (fallbackStarted || speechToken.current !== token) return;
      fallbackStarted = true;
      releaseAudio();
      playWebSpeech(text, token, reason);
    };
    try {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      });
      if (!response.ok) throw new Error(`sapi-http-${response.status}`);
      if (speechToken.current !== token) return;
      const url = URL.createObjectURL(await response.blob());
      audioUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onplay = () => {
        if (speechToken.current !== token) return;
        setTtsError("");
        setTtsState("speaking");
        setSpeaking(true);
      };
      audio.onended = () => {
        if (speechToken.current !== token) return;
        setSpeaking(false);
        setTtsState("ready");
        setLastSpeechAt(Date.now());
        releaseAudio();
      };
      audio.onerror = () => {
        fallback("sapi-audio:error");
      };
      await audio.play();
    } catch (cause) {
      if (speechToken.current !== token) return;
      const reason = cause instanceof DOMException
        ? cause.name
        : cause instanceof Error
          ? cause.message
          : "unknown";
      fallback(`sapi-audio:${reason}`);
    }
  }

  useEffect(() => {
    let active = true;
    const timer = window.setInterval(async () => {
      try {
        const [sessionResponse, avatarResponse, testSpeechResponse] = await Promise.all([
          fetch("/api/session", { cache: "no-store" }),
          fetch("/api/avatar", { cache: "no-store" }),
          fetch("/api/stage-test-speech", { cache: "no-store" })
        ]);
        const next = await sessionResponse.json() as InterviewSession;
        const nextAvatar = await avatarResponse.json() as AvatarMetadata;
        const testSpeech = await testSpeechResponse.json() as {
          id: number;
          text: string;
          createdAt: number;
        } | null;
        if (!active) return;
        setSession(next);
        setAvatarMedia(nextAvatar);
        if (next.revision > lastRevision.current && next.speakingText) {
          lastRevision.current = next.revision;
          const token = speechToken.current + 1;
          speechToken.current = token;
          void playSpeech(next.speakingText, token);
        }
        if (
          testSpeech &&
          testSpeech.id > lastTestSpeechId.current &&
          Date.now() - testSpeech.createdAt < 10_000
        ) {
          lastTestSpeechId.current = testSpeech.id;
          const token = speechToken.current + 1;
          speechToken.current = token;
          void playSpeech(testSpeech.text, token);
        }
      } catch {
        // Keep the last rendered frame when the controller briefly restarts.
      }
    }, 600);
    return () => {
      active = false;
      window.clearInterval(timer);
      speechToken.current += 1;
      releaseAudio();
      window.speechSynthesis.cancel();
    };
  }, []);

  useEffect(() => {
    const report = () => {
      const ttsSupported = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
      void fetch("/api/stage-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ttsSupported,
          voiceCount: ttsSupported ? window.speechSynthesis.getVoices().length : 0,
          ttsState,
          ttsError,
          lastSpeechAt,
          mediaReady
        })
      }).catch(() => undefined);
    };
    report();
    const timer = window.setInterval(report, 3_000);
    return () => window.clearInterval(timer);
  }, [lastSpeechAt, mediaReady, ttsError, ttsState]);

  return (
    <main className="stage">
      <div className="stageBackdrop" />
      {avatarMedia.available ? (
        <section className={`customAvatar ${speaking ? "speaking" : ""}`}>
          {avatarMedia.kind === "video" ? (
            <video
              key={avatarMedia.version}
              src={`/api/avatar/media?v=${avatarMedia.version}`}
              autoPlay
              loop
              muted
              playsInline
              onLoadStart={() => setMediaReady(false)}
              onLoadedData={() => setMediaReady(true)}
              onError={() => setMediaReady(false)}
            />
          ) : (
            <img
              key={avatarMedia.version}
              src={`/api/avatar/media?v=${avatarMedia.version}`}
              alt=""
              onLoad={() => setMediaReady(true)}
              onError={() => setMediaReady(false)}
            />
          )}
          <span className="speechGlow" />
        </section>
      ) : (
        <section className={`avatar ${speaking ? "speaking" : ""}`}>
          <div className="hair" />
          <div className="face">
            <span className="brow left" /><span className="brow right" />
            <span className="eye left" /><span className="eye right" />
            <span className="nose" />
            <span className="mouth" />
          </div>
          <div className="neck" />
          <div className="body" />
        </section>
      )}
      <section className="lowerThird">
        <div>
          <strong>AI 面试官</strong>
          <span>{session?.roleName || "招聘面试"}</span>
        </div>
        <i className={speaking ? "live" : ""}>{speaking ? "正在提问" : "正在聆听"}</i>
      </section>
      {currentSpeechText && <p className="caption">{currentSpeechText}</p>}
      {playbackBlocked && currentSpeechText && (
        <button
          className="stageAudioUnlock"
          onClick={() => {
            const token = speechToken.current + 1;
            speechToken.current = token;
            void playSpeech(currentSpeechText, token);
          }}
        >
          点击启用声音并重播
        </button>
      )}
    </main>
  );
}
