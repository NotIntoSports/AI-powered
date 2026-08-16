"use client";

import { useEffect, useState } from "react";
import type { SubtitleLine } from "../../lib/subtitles/contract.ts";
import { subtitleSink } from "../../lib/subtitles/sink.ts";

export function LiveSubtitles() {
  const [lines, setLines] = useState<SubtitleLine[]>([]);
  useEffect(() => subtitleSink.subscribe(setLines), []);
  return (
    <article className="card liveSubtitles">
      <div className="cardHeading"><h2>实时字幕</h2><span>{lines.length ? "实时字幕" : "等待语音"}</span></div>
      <div aria-live="polite">
        {lines.length === 0 ? <p className="muted">选择会议进程并连接字幕线路后，对方字幕会显示在这里。</p> : lines.slice(-20).map((line) => (
          <p key={`${line.sessionId}-${line.utteranceId}`}><strong>{line.final ? "已确认" : "识别中"}</strong> {line.text}</p>
        ))}
      </div>
    </article>
  );
}
