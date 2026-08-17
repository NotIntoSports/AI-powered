"use client";

import { useEffect, useState } from "react";
import { ConsoleShell, formatTime } from "../console-shell";
import { useAdminSession } from "../use-admin-session";
import {
  displayError,
  parseAPIError,
  requestJSON,
  type ResumeRecord
} from "../../lib/control-api";

export default function ResumesPage() {
  const { me, error, setError } = useAdminSession();
  const [items, setItems] = useState<ResumeRecord[]>([]);

  const [busyId, setBusyId] = useState("");

  async function load() {
    const result = await requestJSON("/api/v1/admin/resumes");
    if (!result.response.ok) {
      setError(displayError(parseAPIError(result.body, "无法加载资料")));
      return;
    }
    setItems(Array.isArray(result.body) ? (result.body as ResumeRecord[]) : []);
    setError("");
  }

  useEffect(() => {
    if (me) void load();
  }, [me]);

  async function download(id: string) {
    const result = await requestJSON(`/api/v1/admin/resumes/${encodeURIComponent(id)}/download`);
    if (!result.response.ok) {
      setError(displayError(parseAPIError(result.body, "无法生成下载链接")));
      return;
    }
    const url = (result.body as { url?: string }).url;
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }

  async function remove(id: string) {
    if (!window.confirm("确定删除这份资料？删除后客户端可以重新上传。")) {
      return;
    }
    const result = await requestJSON(`/api/v1/admin/resumes/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!result.response.ok) {
      setError(displayError(parseAPIError(result.body, "无法删除资料")));
      return;
    }
    setError("");
    await load();
  }

  async function reindex(id: string) {
    setBusyId(id);
    const result = await requestJSON(`/api/v1/admin/resumes/${encodeURIComponent(id)}/reindex`, { method: "POST" });
    setBusyId("");
    if (!result.response.ok) {
      setError(displayError(parseAPIError(result.body, "无法重新索引")));
      return;
    }
    setError("");
    await load();
  }

  const indexLabel: Record<string, string> = {
    pending: "等待索引",
    indexing: "正在索引",
    ready: "已索引",
    failed: "索引失败",
    skipped: "已跳过"
  };

  return (
    <ConsoleShell me={me}>
      {error ? <p className="error">{error}</p> : null}
      <section className="card">
        <h2>资料</h2>
        <p className="muted">上传在 Windows 客户端（参考资料）完成，可多文件或文件夹。管理员可以查看、下载、重新索引和删除；对象存储密钥不会下发到客户端。</p>
      </section>
      <section className="card">
        <h2>已上传</h2>
        <table>
          <thead>
            <tr>
              <th>对象</th>
              <th>文件</th>
              <th>大小</th>
              <th>上传者</th>
              <th>时间</th>
              <th>索引</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr><td colSpan={7} className="muted">还没有资料</td></tr>
            ) : items.map((item) => (
              <tr key={item.id}>
                <td>{item.candidateName || "—"}</td>
                <td>{item.originalFilename}</td>
                <td>{Math.max(1, Math.round(item.sizeBytes / 1024))} KB</td>
                <td>{item.uploadedByUsername || "—"}</td>
                <td>{formatTime(item.createdAt)}</td>
                <td>
                  {indexLabel[item.indexStatus || ""] || item.indexStatus || "—"}
                  {item.indexError ? <div className="muted">{item.indexError}</div> : null}
                </td>
                <td>
                  <div className="tableActions">
                    <button className="secondary" type="button" onClick={() => void download(item.id)}>查看</button>
                    <button className="secondary" type="button" disabled={busyId === item.id} onClick={() => void reindex(item.id)}>重新索引</button>
                    <button className="danger" type="button" onClick={() => void remove(item.id)}>删除</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </ConsoleShell>
  );
}
