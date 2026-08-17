"use client";

import { useCallback, useEffect, useState } from "react";
import { AudioRouteControl } from "../audio/audio-route-control";
import {
  getSnapshotReadiness,
  loadReadinessSnapshot,
  setReadinessVerification
} from "../readiness/readiness-snapshot";
import { loadOutputMode, subscribeOutputMode, type OutputMode } from "../readiness/output-mode";
import { MeetingHandoffControl } from "./meeting-handoff-control";

function prerequisitesForMode(mode: OutputMode, snapshot: ReturnType<typeof getSnapshotReadiness>) {
  if (mode === "virtual") {
    return (
      snapshot.obsConnected &&
      snapshot.virtualCameraActive &&
      snapshot.virtualCameraVerified &&
      snapshot.virtualAudioReady
    );
  }
  return snapshot.virtualAudioReady;
}

export function MeetingAccessCard() {
  const [outputMode, setOutputMode] = useState<OutputMode>("real");
  const [virtualAudioReady, setVirtualAudioReady] = useState(false);
  const [prerequisitesReady, setPrerequisitesReady] = useState(false);

  const refreshSnapshot = useCallback(() => {
    const mode = loadOutputMode();
    const snapshot = getSnapshotReadiness(loadReadinessSnapshot());
    setOutputMode(mode);
    setVirtualAudioReady(snapshot.virtualAudioReady);
    setPrerequisitesReady(prerequisitesForMode(mode, snapshot));
  }, []);

  useEffect(() => {
    refreshSnapshot();
    const stopMode = subscribeOutputMode(refreshSnapshot);
    const timer = window.setInterval(refreshSnapshot, 1_000);
    return () => {
      stopMode();
      window.clearInterval(timer);
    };
  }, [refreshSnapshot]);

  const handleVirtualAudioReady = useCallback(
    (ready: boolean) => {
      setVirtualAudioReady(ready);
      setReadinessVerification("virtualAudioReady", ready);
      refreshSnapshot();
    },
    [refreshSnapshot]
  );

  const handleMeetingPreviewConfirmed = useCallback(
    (ready: boolean) => {
      setReadinessVerification("meetingPreviewConfirmed", ready);
      refreshSnapshot();
    },
    [refreshSnapshot]
  );

  const realMode = outputMode === "real";

  return (
    <div className="meetingAccessStack" aria-label="会议接入">
      <article className="card meetingAccessCard">
        <div className="cardHeading">
          <h2>会议接入</h2>
          <span className={virtualAudioReady ? "ready" : ""}>
            {virtualAudioReady ? "虚拟音频已检测" : "配置虚拟声卡"}
          </span>
        </div>
        <p className="muted">
          {realMode
            ? "会议画面用自己的真实摄像头；麦克风可选虚拟声卡把 AI 语音送进会议。请打开助手舞台以便线路实测与播报。"
            : "在会议软件入会预览中选择 OBS Virtual Camera 与虚拟麦克风。OBS 与舞台检测请到设置页完成。"}
        </p>
        <a className="textLink" href={realMode ? "/settings" : "/settings?focus=virtual"}>
          {realMode ? "打开设置中的虚拟声卡检测 →" : "打开设置中的 OBS / 摄像头检测 →"}
        </a>
        {realMode ? (
          <a className="textLink" href="/stage" target="_blank" rel="noreferrer">
            打开助手舞台 ↗
          </a>
        ) : null}
      </article>
      <AudioRouteControl onReadyChange={handleVirtualAudioReady} />
      <MeetingHandoffControl
        outputMode={outputMode}
        prerequisitesReady={prerequisitesReady}
        onConfirmedChange={handleMeetingPreviewConfirmed}
      />
    </div>
  );
}
