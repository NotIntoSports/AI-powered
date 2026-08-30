"use client";

import { useEffect, useState } from "react";
import { ConsoleShell, formatTime } from "../console-shell";
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

  const online = lines.filter((line) => line.online);
  const browserLines = online.filter((line) => line.purpose === "browser");
  const desktopLines = online.filter((line) => line.purpose === "desktop");

  function LineTable({ items, emptyText }: { items: SessionLine[]; emptyText: string }) {
    return (
      <table>
        <thead>
          <tr>
            <th>用户</th>
            <th>设备</th>
            <th>建立时间</th>
            <th>最近使用</th>
            <th>过期</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr><td colSpan={5} className="muted">{emptyText}</td></tr>
          ) : items.map((line) => (
            <tr key={line.id}>
              <td>{line.username}</td>
              <td>{line.deviceId || "—"}</td>
              <td>{formatTime(line.createdAt)}</td>
              <td>{formatTime(line.lastUsedAt || line.createdAt)}</td>
              <td>{formatTime(line.expiresAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <ConsoleShell me={me}>
      {error ? <p className="error">{error}</p> : null}
      <section className="card">
        <h2>当前线路</h2>
        <p className="muted">
          只显示最近 15 分钟有 API 活动的在线会话，并将管理后台与 Windows 客户端分开列出。
        </p>
        <h3>管理后台在线</h3>
        <LineTable items={browserLines} emptyText="当前没有在线的管理后台" />
        <h3>Windows 客户端在线</h3>
        <LineTable items={desktopLines} emptyText="当前没有在线的 Windows 客户端" />
      </section>
    </ConsoleShell>
  );
}
