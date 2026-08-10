"use client";

import { useEffect, useState } from "react";

type SubtitleLine = { userId: string; sequence: number; text: string; final: boolean };

export function LiveSubtitles() {
  const [lines, setLines] = useState<SubtitleLine[]>([]);
  useEffect(() => {
    const listener = (event: Event) => {
      const line = (event as CustomEvent<SubtitleLine>).detail;
      setLines((current) => [...current.filter((item) => item.userId !== line.userId || item.sequence !== line.sequence), line]
        .sort((left, right) => left.sequence - right.sequence).slice(-20));
    };
    window.addEventListener("rtc-subtitle", listener);
    return () => window.removeEventListener("rtc-subtitle", listener);
  }, []);
  return (
    <article className="card liveSubtitles">
      <div className="cardHeading"><h2>实时字幕</h2><span>{lines.length ? "火山 RTC" : "等待语音"}</span></div>
      <div aria-live="polite">
        {lines.length === 0 ? <p className="muted">选择会议进程并连接 RTC 后，候选人字幕会显示在这里。</p> : lines.map((line) => (
          <p key={`${line.userId}-${line.sequence}`}><strong>{line.final ? "已确认" : "识别中"}</strong> {line.text}</p>
        ))}
      </div>
    </article>
  );
}
