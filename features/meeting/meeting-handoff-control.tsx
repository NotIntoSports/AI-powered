"use client";

import { useEffect, useState } from "react";
import { canConfirmMeetingHandoff } from "./meeting-handoff";

type MeetingHandoffControlProps = {
  prerequisitesReady: boolean;
  onConfirmedChange?: (confirmed: boolean) => void;
};

const meetingSoftwareSuggestions = [
  "腾讯会议",
  "飞书会议",
  "钉钉",
  "Zoom",
  "Microsoft Teams"
];

export function MeetingHandoffControl({
  prerequisitesReady,
  onConfirmedChange
}: MeetingHandoffControlProps) {
  const [software, setSoftware] = useState("");
  const [videoConfirmed, setVideoConfirmed] = useState(false);
  const [audioConfirmed, setAudioConfirmed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  function resetConfirmation() {
    setConfirmed(false);
    onConfirmedChange?.(false);
  }

  useEffect(() => {
    if (prerequisitesReady) return;
    setVideoConfirmed(false);
    setAudioConfirmed(false);
    setConfirmed(false);
    onConfirmedChange?.(false);
  }, [prerequisitesReady, onConfirmedChange]);

  function updateSoftware(value: string) {
    setSoftware(value);
    resetConfirmation();
  }

  function updateVideo(value: boolean) {
    setVideoConfirmed(value);
    resetConfirmation();
  }

  function updateAudio(value: boolean) {
    setAudioConfirmed(value);
    resetConfirmation();
  }

  function confirm() {
    if (!canConfirmMeetingHandoff({
      prerequisitesReady,
      software,
      videoConfirmed,
      audioConfirmed
    })) return;
    setConfirmed(true);
    onConfirmedChange?.(true);
  }

  return (
    <article className="card meetingHandoff">
      <div className="cardHeading">
        <h2>候选人指定会议软件 · 入会预览</h2>
        <span className={confirmed ? "ready" : ""}>
          {confirmed ? "最后一跳已确认" : "等待确认"}
        </span>
      </div>
      <p className="muted">
        本页面无法读取第三方会议软件内部的设备选择。请先停止上方摄像头预览释放设备，
        再进入会议软件的入会预览完成以下确认。
      </p>
      <label>
        本场使用的会议软件
        <input
          list="meeting-software-suggestions"
          value={software}
          onChange={(event) => updateSoftware(event.target.value)}
          placeholder="例如：腾讯会议；也可填写其他软件"
          disabled={!prerequisitesReady}
        />
        <datalist id="meeting-software-suggestions">
          {meetingSoftwareSuggestions.map((name) => <option value={name} key={name} />)}
        </datalist>
      </label>
      <label className="meetingConfirmation">
        <input
          type="checkbox"
          checked={videoConfirmed}
          onChange={(event) => updateVideo(event.target.checked)}
          disabled={!prerequisitesReady}
        />
        <span>摄像头已选择“OBS Virtual Camera”，入会预览能看到数字人画面。</span>
      </label>
      <label className="meetingConfirmation">
        <input
          type="checkbox"
          checked={audioConfirmed}
          onChange={(event) => updateAudio(event.target.checked)}
          disabled={!prerequisitesReady}
        />
        <span>麦克风已选择上方检测通过的虚拟麦克风，播放测试语音时音量条有波动。</span>
      </label>
      <div className="meetingHandoffActions">
        <button
          type="button"
          disabled={
            !canConfirmMeetingHandoff({
              prerequisitesReady,
              software,
              videoConfirmed,
              audioConfirmed
            }) ||
            confirmed
          }
          onClick={confirm}
        >
          {confirmed ? "入会预览已确认" : "确认本场会议输出"}
        </button>
        {confirmed && (
          <button className="secondary" type="button" onClick={resetConfirmation}>
            重新检查
          </button>
        )}
      </div>
      {!prerequisitesReady && (
        <p className="muted">请先通过虚拟摄像头预览和虚拟麦克风端到端信号检测。</p>
      )}
    </article>
  );
}
