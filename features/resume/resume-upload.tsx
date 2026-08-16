"use client";

import { useCallback, useEffect, useState } from "react";
import { readControlSession, type ControlUser } from "../auth/control-session";

type ResumeRecord = {
  id: string;
  candidateName: string;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  indexStatus?: string;
  indexError?: string;
};

const indexStatusLabel: Record<string, string> = {
  pending: "等待索引",
  indexing: "正在索引",
  ready: "已索引",
  failed: "索引失败",
  skipped: "已跳过"
};

function resumeError(data: { code?: string; message?: string } | null, fallback: string) {
  switch (data?.code) {
    case "UNAUTHENTICATED":
      return "请先在客户端登录后再管理简历";
    case "RESUME_NOT_FOUND":
      return "简历不存在或已删除";
    case "STORAGE_NOT_CONFIGURED":
      return "对象存储尚未配置";
    default:
      return data?.message || fallback;
  }
}

function formatSize(bytes: number) {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatTime(value: string) {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value || "—";
  }
  return new Date(parsed).toLocaleString("zh-CN", { hour12: false });
}

export function ResumeUpload({
  candidateName,
  selectedId,
  onSelect
}: {
  candidateName: string;
  selectedId?: string;
  onSelect?: (resumeId: string) => void;
}) {
  const [connected, setConnected] = useState(false);
  const [user, setUser] = useState<ControlUser | null>(null);
  const [items, setItems] = useState<ResumeRecord[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/resume", { cache: "no-store" });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(resumeError(data, "无法加载已上传的简历"));
        return;
      }
      setItems(Array.isArray(data) ? data : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void readControlSession().then((session) => {
      setConnected(session.connected);
      setUser(session.user);
      if (session.connected) {
        void load();
      }
    });
  }, [load]);

  useEffect(() => {
    const selected = items.find((item) => item.id === selectedId);
    if (!selected || (selected.indexStatus !== "pending" && selected.indexStatus !== "indexing")) {
      return;
    }
    const timer = window.setInterval(() => {
      void fetch(`/api/resume/${encodeURIComponent(selected.id)}/status`, { cache: "no-store" })
        .then((response) => response.json().catch(() => null))
        .then((status) => {
          if (!status?.indexStatus) {
            return;
          }
          setItems((current) => current.map((item) => (
            item.id === selected.id
              ? { ...item, indexStatus: status.indexStatus, indexError: status.indexError }
              : item
          )));
        });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [items, selectedId]);

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
        setError(resumeError(data, "简历上传失败"));
        return;
      }
      setFile(null);
      setFileInputKey((current) => current + 1);
      setMessage(`已上传：${data?.originalFilename || file.name}`);
      if (typeof data?.id === "string" && data.id) {
        onSelect?.(data.id);
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function viewResume(id: string) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/resume/${encodeURIComponent(id)}`, { cache: "no-store" });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(resumeError(data, "无法打开简历"));
        return;
      }
      const url = data?.url;
      if (typeof url !== "string" || !url) {
        setError("无法打开简历");
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    } finally {
      setBusy(false);
    }
  }

  async function deleteResume(id: string) {
    if (!window.confirm("确定删除这份简历？删除后可以重新上传。")) {
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/resume/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        setError(resumeError(data, "删除失败"));
        return;
      }
      setMessage("已删除，可重新上传");
      if (selectedId === id) {
        onSelect?.("");
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  const selected = items.find((item) => item.id === selectedId);

  return (
    <div className="resumeBox">
      <strong>候选人简历</strong>
      {connected ? (
        <p className="muted">已用客户端账号 {user?.username ? `（${user.username}）` : ""}登录。可查看已上传文件，删除后重新上传。管理员也可在后台查看。</p>
      ) : (
        <p className="muted">管理简历需要先连接管理端。<a className="textLink" href="/login">前往登录</a></p>
      )}
      {connected ? (
        <>
          {loading && items.length === 0 ? <p className="muted">正在加载已上传简历…</p> : null}
          {items.length > 0 ? (
            <ul className="resumeList">
              {items.map((item) => (
                <li key={item.id} className={`resumeItem ${item.id === selectedId ? "selected" : ""}`}>
                  <div>
                    <p className="resumeName">{item.originalFilename}</p>
                    <p className="muted">
                      {item.candidateName ? `${item.candidateName} · ` : ""}
                      {formatSize(item.sizeBytes)} · {formatTime(item.createdAt)}
                      {item.indexStatus ? ` · ${indexStatusLabel[item.indexStatus] || item.indexStatus}` : ""}
                    </p>
                  </div>
                  <div className="resumeItemActions">
                    <button type="button" className="secondary" disabled={busy} onClick={() => onSelect?.(item.id)}>
                      {item.id === selectedId ? "本场使用中" : "用于本场"}
                    </button>
                    <button type="button" className="secondary" disabled={busy} onClick={() => void viewResume(item.id)}>
                      查看
                    </button>
                    <button type="button" className="danger" disabled={busy} onClick={() => void deleteResume(item.id)}>
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : !loading ? (
            <p className="muted">还没有上传简历。</p>
          ) : null}
          {selected && selected.indexStatus && selected.indexStatus !== "ready" ? (
            <p className="muted">索引未完成时仍可开始，追问会暂时不含简历参考。</p>
          ) : null}
          <label>
            {items.length > 0 ? "上传新简历" : "简历文件"}
            <input
              key={fileInputKey}
              type="file"
              accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={(event) => setFile(event.target.files?.[0] || null)}
            />
          </label>
          <button type="button" className="secondary" disabled={busy} onClick={() => void upload()}>
            {items.length > 0 ? "上传新简历" : "上传简历"}
          </button>
        </>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      {message ? <p className="muted">{message}</p> : null}
    </div>
  );
}
