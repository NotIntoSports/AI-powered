"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
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

const ACCEPT =
  ".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_BYTES = 10 * 1024 * 1024;

const indexStatusLabel: Record<string, string> = {
  pending: "等待索引",
  indexing: "正在索引",
  ready: "已索引",
  failed: "索引失败",
  skipped: "已跳过"
};

function formatIndexError(error?: string) {
  const text = error?.trim();
  if (!text) {
    return "";
  }
  if (text.includes("no extractable text")) {
    return "无法提取文字（可能是扫描件或图片版 PDF）";
  }
  if (text.includes(".doc is not supported")) {
    return "不支持旧版 .doc，请另存为 PDF 或 .docx";
  }
  if (/embedding|tei|unavailable/i.test(text)) {
    return "向量服务不可用，请确认管理端 embedding 已启动";
  }
  return text;
}

function materialError(data: { code?: string; message?: string } | null, fallback: string) {
  switch (data?.code) {
    case "UNAUTHENTICATED":
      return "请先在客户端登录后再管理资料";
    case "RESUME_NOT_FOUND":
      return "资料不存在或已删除";
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

function isAllowedMaterial(file: File) {
  const name = file.name.toLowerCase();
  return name.endsWith(".pdf") || name.endsWith(".doc") || name.endsWith(".docx");
}

function collectFiles(list: FileList | File[] | null | undefined) {
  if (!list) {
    return [] as File[];
  }
  return Array.from(list).filter((file) => file && typeof file.name === "string");
}

export function ResumeUpload({
  candidateName,
  selectedIds,
  onChangeSelection,
  compact = false
}: {
  candidateName: string;
  selectedIds: string[];
  onChangeSelection?: (resumeIds: string[]) => void;
  /** Hide the outer title when embedded in the top-right upload dock. */
  compact?: boolean;
}) {
  const [connected, setConnected] = useState(false);
  const [user, setUser] = useState<ControlUser | null>(null);
  const [items, setItems] = useState<ResumeRecord[]>([]);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [folderInputKey, setFolderInputKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const dragDepth = useRef(0);

  const selectedSet = new Set(selectedIds);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/resume", { cache: "no-store" });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(materialError(data, "无法加载已上传的资料"));
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
    const watching = items.filter(
      (item) =>
        selectedSet.has(item.id) &&
        (item.indexStatus === "pending" || item.indexStatus === "indexing")
    );
    if (watching.length === 0) {
      return;
    }
    const timer = window.setInterval(() => {
      for (const selected of watching) {
        void fetch(`/api/resume/${encodeURIComponent(selected.id)}/status`, { cache: "no-store" })
          .then((response) => response.json().catch(() => null))
          .then((status) => {
            if (!status?.indexStatus) {
              return;
            }
            setItems((current) =>
              current.map((item) =>
                item.id === selected.id
                  ? { ...item, indexStatus: status.indexStatus, indexError: status.indexError }
                  : item
              )
            );
          });
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [items, selectedIds]);

  function queueFiles(raw: File[]) {
    const allowed: File[] = [];
    let skippedType = 0;
    let skippedSize = 0;
    for (const file of raw) {
      if (!isAllowedMaterial(file)) {
        skippedType += 1;
        continue;
      }
      if (file.size > MAX_BYTES) {
        skippedSize += 1;
        continue;
      }
      allowed.push(file);
    }
    if (allowed.length === 0) {
      setError(
        skippedType || skippedSize
          ? `没有可上传的 PDF/Word 资料${skippedSize ? "（部分超过 10MB）" : ""}`
          : "请选择 PDF 或 Word 资料"
      );
      return;
    }
    setPendingFiles((current) => {
      const names = new Set(current.map((file) => `${file.name}:${file.size}`));
      const next = [...current];
      for (const file of allowed) {
        const key = `${file.name}:${file.size}`;
        if (!names.has(key)) {
          names.add(key);
          next.push(file);
        }
      }
      return next;
    });
    const notes: string[] = [`已加入 ${allowed.length} 个文件到待上传`];
    if (skippedType) {
      notes.push(`已跳过 ${skippedType} 个非 PDF/Word 文件`);
    }
    if (skippedSize) {
      notes.push(`已跳过 ${skippedSize} 个超过 10MB 的文件`);
    }
    setError("");
    setMessage(notes.join("；"));
  }

  async function uploadQueued() {
    if (pendingFiles.length === 0) {
      setError("请先选择或拖入 PDF/Word 资料");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    const uploadedIds: string[] = [];
    const failures: string[] = [];
    try {
      for (const file of pendingFiles) {
        const body = new FormData();
        body.set("candidateName", candidateName.trim());
        body.set("file", file);
        const response = await fetch("/api/resume", { method: "POST", body });
        const data = await response.json().catch(() => null);
        if (!response.ok) {
          failures.push(`${file.name}：${materialError(data, "上传失败")}`);
          continue;
        }
        if (typeof data?.id === "string" && data.id) {
          uploadedIds.push(data.id);
        }
      }
      setPendingFiles([]);
      setFileInputKey((current) => current + 1);
      setFolderInputKey((current) => current + 1);
      if (uploadedIds.length > 0) {
        const next = [...new Set([...selectedIds, ...uploadedIds])];
        onChangeSelection?.(next);
      }
      await load();
      const parts: string[] = [];
      if (uploadedIds.length) {
        parts.push(`已上传 ${uploadedIds.length} 份资料`);
      }
      if (failures.length) {
        parts.push(`${failures.length} 份失败`);
        setError(failures.slice(0, 3).join("；"));
      }
      setMessage(parts.join("，") || "");
    } finally {
      setBusy(false);
    }
  }

  async function viewMaterial(id: string) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/resume/${encodeURIComponent(id)}`, { cache: "no-store" });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(materialError(data, "无法打开资料"));
        return;
      }
      const url = data?.url;
      if (typeof url !== "string" || !url) {
        setError("无法打开资料");
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    } finally {
      setBusy(false);
    }
  }

  async function deleteMaterial(id: string) {
    if (!window.confirm("确定删除这份资料？删除后可以重新上传。")) {
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/resume/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        setError(materialError(data, "删除失败"));
        return;
      }
      setMessage("已删除，可重新上传");
      if (selectedSet.has(id)) {
        onChangeSelection?.(selectedIds.filter((item) => item !== id));
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  function toggleSelected(id: string) {
    if (selectedSet.has(id)) {
      onChangeSelection?.(selectedIds.filter((item) => item !== id));
      return;
    }
    onChangeSelection?.([...selectedIds, id]);
  }

  function onDragEnter(event: DragEvent) {
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }

  function onDragLeave(event: DragEvent) {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) {
      setDragging(false);
    }
  }

  function onDragOver(event: DragEvent) {
    event.preventDefault();
  }

  async function onDrop(event: DragEvent) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const transfer = event.dataTransfer;
    if (!transfer) {
      return;
    }
    const fromList = collectFiles(transfer.files);
    if (fromList.length > 0) {
      queueFiles(fromList);
      return;
    }
    const itemsList = Array.from(transfer.items || []);
    const files: File[] = [];
    for (const item of itemsList) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }
    queueFiles(files);
  }

  const selectedItems = items.filter((item) => selectedSet.has(item.id));
  const pendingIndex = selectedItems.filter(
    (item) => item.indexStatus && item.indexStatus !== "ready"
  );

  return (
    <div className={`resumeBox ${compact ? "compact" : ""}`}>
      {compact ? null : <strong>参考资料</strong>}
      {connected ? (
        <p className="muted">
          已用客户端账号 {user?.username ? `（${user.username}）` : ""}登录。可上传多份 PDF/Word，或拖入文件夹；勾选后加入本场。
        </p>
      ) : (
        <p className="muted">
          管理资料需要先连接管理端。<a className="textLink" href="/login">前往登录</a>
        </p>
      )}
      {connected ? (
        <>
          {loading && items.length === 0 ? <p className="muted">正在加载已上传资料…</p> : null}
          {items.length > 0 ? (
            <ul className="resumeList">
              {items.map((item) => (
                <li key={item.id} className={`resumeItem ${selectedSet.has(item.id) ? "selected" : ""}`}>
                  <div>
                    <p className="resumeName">{item.originalFilename}</p>
                    <p className="muted">
                      {item.candidateName ? `${item.candidateName} · ` : ""}
                      {formatSize(item.sizeBytes)} · {formatTime(item.createdAt)}
                      {item.indexStatus ? ` · ${indexStatusLabel[item.indexStatus] || item.indexStatus}` : ""}
                    </p>
                    {item.indexStatus === "failed" || item.indexStatus === "skipped" ? (
                      <p className="resumeIndexError" role="status">
                        {formatIndexError(item.indexError) ||
                          (item.indexStatus === "skipped"
                            ? "当前文件类型无法建立索引"
                            : "原因未知，可删除后重新上传，或到管理端重新索引")}
                      </p>
                    ) : null}
                  </div>
                  <div className="resumeItemActions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => toggleSelected(item.id)}
                    >
                      {selectedSet.has(item.id) ? "本场已加入" : "加入本场"}
                    </button>
                    <button type="button" className="secondary" disabled={busy} onClick={() => void viewMaterial(item.id)}>
                      查看
                    </button>
                    <button type="button" className="danger" disabled={busy} onClick={() => void deleteMaterial(item.id)}>
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : !loading ? (
            <p className="muted">还没有上传资料。</p>
          ) : null}
          {pendingIndex.length > 0 ? (
            <p className="muted">
              有 {pendingIndex.length} 份本场资料索引未完成，追问会暂时不含这些资料参考。
            </p>
          ) : null}
          <div
            className={`resumeDropZone ${dragging ? "dragging" : ""}`}
            onDragEnter={onDragEnter}
            onDragLeave={onDragLeave}
            onDragOver={onDragOver}
            onDrop={(event) => void onDrop(event)}
          >
            <p>
              <strong>拖放文件或文件夹到此处</strong>
            </p>
            <p className="muted">支持 PDF / DOC / DOCX，单文件不超过 10MB；也可多选或选择整个文件夹。</p>
            <div className="resumeUploadActions">
              <label className="buttonLink secondary">
                选择文件
                <input
                  key={fileInputKey}
                  type="file"
                  multiple
                  accept={ACCEPT}
                  hidden
                  onChange={(event) => {
                    queueFiles(collectFiles(event.target.files));
                    event.target.value = "";
                  }}
                />
              </label>
              <label className="buttonLink secondary">
                选择文件夹
                <input
                  key={folderInputKey}
                  type="file"
                  {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                  multiple
                  hidden
                  onChange={(event) => {
                    queueFiles(collectFiles(event.target.files));
                    event.target.value = "";
                  }}
                />
              </label>
            </div>
            {pendingFiles.length > 0 ? (
              <p className="muted">待上传 {pendingFiles.length} 个：{pendingFiles.slice(0, 5).map((file) => file.name).join("、")}{pendingFiles.length > 5 ? "…" : ""}</p>
            ) : null}
          </div>
          <button type="button" className="secondary" disabled={busy || pendingFiles.length === 0} onClick={() => void uploadQueued()}>
            {busy ? "正在上传…" : pendingFiles.length > 0 ? `上传资料（${pendingFiles.length}）` : "上传资料"}
          </button>
        </>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      {message ? <p className="muted">{message}</p> : null}
    </div>
  );
}
