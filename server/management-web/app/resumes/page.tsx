"use client";

import { FormEvent, useEffect, useState } from "react";
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
  const [candidateName, setCandidateName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const result = await requestJSON("/api/v1/admin/resumes");
    if (!result.response.ok) {
      setError(displayError(parseAPIError(result.body, "无法加载简历")));
      return;
    }
    setItems(Array.isArray(result.body) ? (result.body as ResumeRecord[]) : []);
    setError("");
  }

  useEffect(() => {
    if (me) void load();
  }, [me]);

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file) {
      setError("请选择 PDF 或 Word 简历");
      return;
    }
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const body = new FormData();
      body.set("candidateName", candidateName.trim());
      body.set("file", file);
      const response = await fetch("/api/v1/admin/resumes", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        body
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(displayError(parseAPIError(payload, "上传失败")));
        return;
      }
      setFile(null);
      setNotice("简历已上传到腾讯云 COS。");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function download(id: string) {
    const result = await requestJSON(`/api/v1/admin/resumes/${encodeURIComponent(id)}/download`);
    if (!result.response.ok) {
      setError(displayError(parseAPIError(result.body, "无法生成下载链接")));
      return;
    }
    const url = (result.body as { url?: string }).url;
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }

  return (
    <ConsoleShell me={me}>
      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="ok">{notice}</p> : null}
      <form className="card" onSubmit={upload}>
        <h2>上传简历</h2>
        <p className="muted">文件保存到腾讯云 COS，不经过客户端本地长期存储。仅支持 PDF / Word，最大 10MB。</p>
        <label>
          候选人姓名
          <input value={candidateName} onChange={(event) => setCandidateName(event.target.value)} placeholder="可选" />
        </label>
        <label>
          简历文件
          <input
            type="file"
            accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={(event) => setFile(event.target.files?.[0] || null)}
          />
        </label>
        <button type="submit" disabled={busy}>{busy ? "上传中…" : "上传到 COS"}</button>
      </form>
      <section className="card">
        <h2>已上传</h2>
        <table>
          <thead>
            <tr>
              <th>候选人</th>
              <th>文件</th>
              <th>大小</th>
              <th>上传者</th>
              <th>时间</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr><td colSpan={6} className="muted">还没有简历</td></tr>
            ) : items.map((item) => (
              <tr key={item.id}>
                <td>{item.candidateName || "—"}</td>
                <td>{item.originalFilename}</td>
                <td>{Math.max(1, Math.round(item.sizeBytes / 1024))} KB</td>
                <td>{item.uploadedByUsername || "—"}</td>
                <td>{formatTime(item.createdAt)}</td>
                <td><button className="secondary" type="button" onClick={() => void download(item.id)}>下载</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </ConsoleShell>
  );
}
