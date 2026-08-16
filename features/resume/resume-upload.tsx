"use client";

import { FormEvent, useEffect, useState } from "react";

type ControlUser = { username?: string; role?: string };

export function ResumeUpload({ candidateName }: { candidateName: string }) {
  const [connected, setConnected] = useState(false);
  const [user, setUser] = useState<ControlUser | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function refresh() {
    const response = await fetch("/api/control-session", { cache: "no-store" });
    const data = await response.json().catch(() => null);
    setConnected(Boolean(data?.connected));
    setUser(data?.user || null);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function login(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/control-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.message || "管理端登录失败");
        return;
      }
      setPassword("");
      setConnected(true);
      setUser(data?.user || null);
      setMessage("已连接管理端，可以上传简历。");
    } finally {
      setBusy(false);
    }
  }

  async function upload() {
    if (!file) {
      setError("请选择 PDF 或 Word 简历");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const body = new FormData();
      body.set("candidateName", candidateName.trim());
      body.set("file", file);
      const response = await fetch("/api/resume", { method: "POST", body });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.message || "简历上传失败");
        return;
      }
      setFile(null);
      setMessage(`已上传到腾讯云 COS：${data?.originalFilename || file.name}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="resumeBox">
      <strong>候选人简历</strong>
      {connected ? (
        <p className="muted">已连接管理端 {user?.username ? `（${user.username}）` : ""}，文件会保存到腾讯云 COS。</p>
      ) : (
        <form className="resumeLogin" onSubmit={login}>
          <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="管理端用户名" autoComplete="username" />
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="密码" autoComplete="current-password" />
          <button type="submit" disabled={busy}>{busy ? "连接中…" : "连接管理端"}</button>
        </form>
      )}
      <label>
        简历文件
        <input
          type="file"
          accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={(event) => setFile(event.target.files?.[0] || null)}
        />
      </label>
      <button type="button" className="secondary" disabled={busy || !connected} onClick={() => void upload()}>
        {busy ? "上传中…" : "上传到对象存储"}
      </button>
      {error ? <p className="error">{error}</p> : null}
      {message ? <p className="muted">{message}</p> : null}
    </div>
  );
}
