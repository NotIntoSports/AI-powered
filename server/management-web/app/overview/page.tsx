"use client";

import { useEffect, useState } from "react";
import { ConsoleShell, OnlineMark, formatTime } from "../console-shell";
import { useAdminSession } from "../use-admin-session";
import {
  displayError,
  parseAPIError,
  publicUserFromUnknown,
  requestJSON,
  type PublicAISettings,
  type PublicRTCSettings,
  type PublicUser,
  type SessionLine
} from "../../lib/control-api";

export default function OverviewPage() {
  const { me, error, setError } = useAdminSession();
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [lines, setLines] = useState<SessionLine[]>([]);
  const [ai, setAI] = useState<PublicAISettings | null>(null);
  const [rtc, setRTC] = useState<PublicRTCSettings | null>(null);

  async function load() {
    const [usersResult, linesResult, aiResult, rtcResult] = await Promise.all([
      requestJSON("/api/v1/admin/users"),
      requestJSON("/api/v1/admin/sessions"),
      requestJSON("/api/v1/admin/settings/ai"),
      requestJSON("/api/v1/admin/settings/rtc")
    ]);
    if (!usersResult.response.ok) {
      setError(displayError(parseAPIError(usersResult.body, "无法加载账户")));
      return;
    }
    setUsers(
      Array.isArray(usersResult.body)
        ? usersResult.body.map(publicUserFromUnknown).filter((user): user is PublicUser => Boolean(user))
        : []
    );
    setLines(Array.isArray(linesResult.body) ? (linesResult.body as SessionLine[]) : []);
    if (aiResult.response.ok) setAI(aiResult.body as PublicAISettings);
    if (rtcResult.response.ok) setRTC(rtcResult.body as PublicRTCSettings);
    setError("");
  }

  useEffect(() => {
    if (!me) return;
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [me]);

  const onlineUsers = users.filter((user) => user.online).length;
  const onlineLines = lines.filter((line) => line.online).length;

  return (
    <ConsoleShell me={me}>
      {error ? <p className="error">{error}</p> : null}
      <section className="stats">
        <article className="stat">
          <span className="muted">账户在线</span>
          <b>{onlineUsers}/{users.length}</b>
        </article>
        <article className="stat">
          <span className="muted">当前线路</span>
          <b>{onlineLines}/{lines.length}</b>
        </article>
        <article className="stat">
          <span className="muted">AI</span>
          <b>{ai?.available ? "可用" : ai?.configured ? "未就绪" : "未配置"}</b>
        </article>
        <article className="stat">
          <span className="muted">RTC</span>
          <b>{rtc?.available ? "LiveKit" : rtc?.configured ? "未就绪" : "未配置"}</b>
        </article>
      </section>

      <section className="card">
        <h2>在线账户</h2>
        <table>
          <thead>
            <tr>
              <th>用户名</th>
              <th>角色</th>
              <th>状态</th>
              <th>在线</th>
              <th>最后活动</th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr><td colSpan={5} className="muted">暂无用户</td></tr>
            ) : users.map((user) => (
              <tr key={user.id}>
                <td>{user.username}</td>
                <td>{user.role}</td>
                <td>{user.status}</td>
                <td><OnlineMark online={Boolean(user.online)} /></td>
                <td>{formatTime(user.lastSeenAt || user.lastLoginAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>当前线路</h2>
        <p className="muted">未撤销且未过期的浏览器/客户端会话。最近 15 分钟有活动视为在线。</p>
        <table>
          <thead>
            <tr>
              <th>用户</th>
              <th>用途</th>
              <th>状态</th>
              <th>最近使用</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <tr><td colSpan={4} className="muted">当前没有活动线路</td></tr>
            ) : lines.map((line) => (
              <tr key={line.id}>
                <td>{line.username}</td>
                <td>{line.purpose === "desktop" ? "Windows 客户端" : "管理后台"}</td>
                <td><OnlineMark online={line.online} /></td>
                <td>{formatTime(line.lastUsedAt || line.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </ConsoleShell>
  );
}
