"use client";

import { useEffect, useState } from "react";
import type { InterviewSession } from "../../lib/interview";

type AvatarMetadata = { available: boolean; kind?: "image" | "video"; version?: string };
type VisualStageStatus = {
  ttsState?: "idle" | "speaking" | "ready" | "error";
  ttsError?: string;
  captureState?: "off" | "capturing" | "silent";
  captureUpdatedAt?: number;
};

export default function StagePage() {
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [avatarMedia, setAvatarMedia] = useState<AvatarMetadata>({ available: false });
  const [mediaReady, setMediaReady] = useState(true);
  const [stageStatus, setStageStatus] = useState<VisualStageStatus>({});

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const [sessionResponse, avatarResponse, statusResponse] = await Promise.all([
          fetch("/api/session", { cache: "no-store" }),
          fetch("/api/avatar", { cache: "no-store" }),
          fetch("/api/stage-status", { cache: "no-store" })
        ]);
        const [nextSession, nextAvatar, nextStatus] = await Promise.all([
          sessionResponse.json() as Promise<InterviewSession>,
          avatarResponse.json() as Promise<AvatarMetadata>,
          statusResponse.json() as Promise<VisualStageStatus>
        ]);
        if (!active) return;
        setSession(nextSession);
        setAvatarMedia(nextAvatar);
        setStageStatus(nextStatus);
      } catch {
        // Keep the last visual frame while the desktop controller restarts.
      }
    };
    void poll();
    const timer = window.setInterval(poll, 600);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const speaking = stageStatus.ttsState === "speaking";
  const captureFresh = Date.now() - (stageStatus.captureUpdatedAt || 0) < 8_000;
  const captureState = captureFresh ? stageStatus.captureState ?? "off" : "off";

  return (
    <main className="stage">
      <div className="stageBackdrop" />
      {avatarMedia.available ? (
        <section className={`customAvatar ${speaking ? "speaking" : ""}`}>
          {avatarMedia.kind === "video" ? (
            <video
              key={avatarMedia.version}
              src={`/api/avatar/media?v=${avatarMedia.version}`}
              autoPlay loop muted playsInline
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
            <span className="nose" /><span className="mouth" />
          </div>
          <div className="neck" /><div className="body" />
        </section>
      )}
      <section className="lowerThird">
        <div><strong>AI虚拟助手</strong><span>{session?.roleName || "实时互动"}</span></div>
        <i className={speaking ? "live" : ""}>{speaking ? "正在提问" : "正在聆听"}</i>
      </section>
      {captureState !== "capturing" && (
        <p className={captureState === "silent" ? "captureAlert" : "captureHint"}>
          {captureState === "silent"
            ? "采集已开启但未检测到语音：检查共享系统音频/对方是否说话"
            : "未采集会议音频：在主控台点击“开始听取对方”"}
        </p>
      )}
      {session?.speakingText && <p className="caption">{session.speakingText}</p>}
      {stageStatus.ttsState === "error" && stageStatus.ttsError && <p className="captureAlert">{stageStatus.ttsError}</p>}
      {!mediaReady && <p className="captureAlert">助手画面加载失败</p>}
    </main>
  );
}
