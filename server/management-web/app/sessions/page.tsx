"use client";

import { useEffect, useState } from "react";
import { ConsoleShell, OnlineMark, formatTime } from "../console-shell";
import { useAdminSession } from "../use-admin-session";
import { displayError, parseAPIError, requestJSON, type SessionLine } from "../../lib/control-api";

export default function SessionsPage() {
  const { me, error, setError } = useAdminSession();
  const [lines, setLines] = useState<SessionLine[]>([]);

  async function load() {
    const result = await requestJSON("/api/v1/admin/sessions");
    if (!result.response.ok) {
      setError(displayError(parseAPIError(result.body, "无法加载当前线路")));
      return;
    }
    setLines(Array.isArray(result.body) ? (result.body as SessionLine[]) : []);
    setError("");
  }

  useEffect(() => {
    if (!me) return;
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [me]);

  return (
    <ConsoleShell me={me}>
      {error ? <p className="error">{error}</p> : null}
      <section className="card">
        <h2>当前线路</h2>
        <p className="muted">
          这里列出尚未撤销、尚未过期的会话。Windows 客户端登录后会出现 desktop 线路；管理后台登录是 browser 线路。
          最近 15 分钟没有 API 活动会显示为离线，但会话在过期前仍然有效。
        </p>
        <table>
          <thead>
            <tr>
              <th>用户</th>
              <th>线路</th>
              <th>设备</th>
              <th>状态</th>
              <th>建立时间</th>
              <th>最近使用</th>
              <th>过期</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <tr><td colSpan={7} className="muted">当前没有活动线路</td></tr>
            ) : lines.map((line) => (
              <tr key={line.id}>
                <td>{line.username}</td>
                <td>{line.purpose === "desktop" ? "Windows 客户端" : "管理后台"}</td>
                <td>{line.deviceId || "—"}</td>
                <td><OnlineMark online={line.online} /></td>
                <td>{formatTime(line.createdAt)}</td>
                <td>{formatTime(line.lastUsedAt || line.createdAt)}</td>
                <td>{formatTime(line.expiresAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </ConsoleShell>
  );
}
