"use client";

import { useEffect, useState } from "react";
import type { InterviewSession } from "../../lib/interview";
import { AppNavigation } from "../../features/settings/app-navigation";

type ArchivedSessionSummary = {
  sessionId: string;
  candidateName: string;
  roleName: string;
  startedAt: string | null;
  finishedAt: string | null;
  questionCount: number;
  reportReady: boolean;
};

const emptySession: InterviewSession = {
  sessionId: "", revision: 0, status: "idle", speakingText: "", candidateName: "",
  roleName: "", jobDescription: "", interviewFocus: "", maxQuestions: 6,
  consentConfirmed: false, consentConfirmedAt: null, startedAt: null, finishedAt: null,
  transcript: [], report: null
};

export default function RecordsPage() {
  const [session, setSession] = useState(emptySession);
  const [history, setHistory] = useState<ArchivedSessionSummary[]>([]);
  const [modelConfigured, setModelConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    void Promise.all([
      fetch("/api/session", { cache: "no-store" }).then((response) => response.json()),
      fetch("/api/sessions", { cache: "no-store" }).then((response) => response.json()),
      fetch("/api/health", { cache: "no-store" }).then((response) => response.json())
    ]).then(([current, archived, health]) => {
      setSession(current); setHistory(archived); setModelConfigured(Boolean(health.modelConfigured));
    }).catch(() => setError("无法读取面试记录")).finally(() => setLoading(false));
  }, []);

  async function refreshHistory() {
    const response = await fetch("/api/sessions", { cache: "no-store" });
    if (response.ok) setHistory(await response.json());
  }

  async function generateReport() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/session", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generateReport" })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "纪要生成失败");
      setSession(data); await refreshHistory();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "纪要生成失败");
    } finally { setBusy(false); }
  }

  async function deleteHistoryItem(item: ArchivedSessionSummary) {
    const label = `${item.candidateName || "未命名候选人"} · ${item.roleName || "未填写岗位"}`;
    if (!window.confirm(`确定永久删除“${label}”的本地面试记录和 AI 纪要吗？此操作无法恢复。`)) return;
    setError("");
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(item.sessionId)}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "删除失败");
      if (session.sessionId === item.sessionId) setSession(emptySession);
      await refreshHistory();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "删除失败"); }
  }

  return (
    <main className="console recordsPage">
      <header className="topbar"><div><p className="eyebrow">INTERVIEW ARCHIVE</p><h1>面试记录</h1></div><AppNavigation current="records" /></header>
      {error && <p className="error" role="alert">{error}</p>}
      {loading ? <article className="card recordsLoading"><p className="muted">正在读取本机面试记录…</p></article> : <section className="recordsGrid">
        <article className="card report currentReport">
          <div className="cardHeading"><h2>最近一场面试纪要</h2><span>{session.report ? "已生成" : session.status === "finished" ? "可生成" : "暂无已结束面试"}</span></div>
          {!session.report ? <><p className="muted">面试结束后，可根据候选人原始回答生成证据型纪要。AI 不提供录用建议或候选人排名。</p><button disabled={busy || session.status !== "finished" || !modelConfigured} onClick={generateReport}>{busy ? "正在生成…" : "生成面试纪要"}</button>{session.status === "finished" && !modelConfigured && <a className="textLink" href="/settings">请先配置 AI 模型</a>}</> : <div className="reportBody"><p>{session.report.summary}</p><ReportList title="明确表现" items={session.report.strengths} /><ReportList title="建议人工追核" items={session.report.followUps} /><ReportList title="信息限制" items={session.report.limitations} />{session.report.evidence.length > 0 && <section><h3>证据记录</h3><div className="reportEvidence">{session.report.evidence.map((item) => <article key={`${item.topic}-${item.observation}`}><strong>{item.topic}</strong><p>{item.observation}</p>{item.quotes.map((quote) => <blockquote key={quote}>“{quote}”</blockquote>)}</article>)}</div></section>}<p className="humanReview">需由招聘人员结合岗位标准和原始记录进行人工复核。</p></div>}
        </article>
        <article className="card history"><div className="cardHeading"><h2>历史面试</h2><span>{history.length} 场</span></div>{history.length === 0 ? <p className="muted">结束一场面试后会自动归档。</p> : <div className="historyList">{history.slice(0, 50).map((item) => <div key={item.sessionId}><div><strong>{item.candidateName || "未命名候选人"}</strong><span>{item.roleName || "未填写岗位"} · {item.questionCount} 问</span></div><span>{item.reportReady ? "含纪要" : "仅记录"}</span><a href={`/api/sessions/${encodeURIComponent(item.sessionId)}/export`}>JSON</a><a href={`/api/sessions/${encodeURIComponent(item.sessionId)}/export?format=markdown`}>Markdown</a><button className="historyDelete" type="button" onClick={() => deleteHistoryItem(item)}>删除</button></div>)}</div>}</article>
      </section>}
    </main>
  );
}

function ReportList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return <section><h3>{title}</h3><ul>{items.map((item) => <li key={item}>{item}</li>)}</ul></section>;
}
