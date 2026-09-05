import { useCallback, useEffect, useState } from "react";

import * as api from "../../api/commands";
import type { CommandResult, SessionDetail, SessionSummary } from "../../generated/bindings";

const errorText = (error: { code: string; message: string; field?: string | null }) =>
  `${error.field ? error.field + "：" : ""}${error.code}：${error.message}`;

export function RecordsList() {
  const [items, setItems] = useState<SessionSummary[]>([]);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [message, setMessage] = useState("正在读取会话记录…");
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const result = await api.listSessions();
      if (result.ok) {
        setItems(result.data);
        setMessage("");
      } else {
        setMessage(errorText(result.error));
      }
    } catch {
      setMessage("IPC_UNAVAILABLE：无法读取会话记录");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(action: () => Promise<CommandResult<unknown>>, success: string) {
    setBusy(true);
    try {
      const result = await action();
      await reload();
      if (!result.ok) {
        setMessage(errorText(result.error));
        return false;
      }
      setMessage(success);
      return true;
    } catch {
      await reload();
      setMessage("IPC_UNAVAILABLE：本地操作失败");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function openDetail(id: string) {
    setBusy(true);
    try {
      const result = await api.getSession(id);
      if (!result.ok) {
        setMessage(errorText(result.error));
        return;
      }
      setDetail(result.data);
      setMessage("");
    } catch {
      setMessage("IPC_UNAVAILABLE：本地操作失败");
    } finally {
      setBusy(false);
    }
  }

  async function exportRecord(format: "markdown" | "json" | "text") {
    if (!detail) return;
    setBusy(true);
    try {
      const result = await api.exportSession(detail.session.id, format);
      if (!result.ok) {
        setMessage(errorText(result.error));
        return;
      }
      setMessage(result.data.path);
    } catch {
      setMessage("IPC_UNAVAILABLE：本地操作失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="service-panel records-list" aria-labelledby="records-list-heading">
      <h2 id="records-list-heading">会话记录</h2>
      {message && (
        <p className="services-message" role="status">
          {message}
        </p>
      )}
      {detail ? (
        <div className="service-list" aria-label="会话详情">
          <article className="service-card">
            <h3>{detail.session.id}</h3>
            <p>{detail.session.status}</p>
            <div className="service-actions">
              <button disabled={busy} type="button" onClick={() => setDetail(null)}>
                返回列表
              </button>
              <button disabled={busy} type="button" onClick={() => void exportRecord("markdown")}>
                导出 Markdown
              </button>
              <button disabled={busy} type="button" onClick={() => void exportRecord("json")}>
                导出 JSON
              </button>
              <button disabled={busy} type="button" onClick={() => void exportRecord("text")}>
                导出文本
              </button>
            </div>
          </article>
          {detail.turns.map((item) => (
            <article className="service-card" key={item.id}>
              <h3>回合 {item.turnIndex}</h3>
              <p>{item.userText}</p>
              <p>{item.assistantText}</p>
              {!item.materialsUsed && <p>本轮未使用资料</p>}
              {item.citations.map((citation) => (
                <p key={`${citation.materialId}-${citation.chunkId}`}>{citation.snippet}</p>
              ))}
            </article>
          ))}
        </div>
      ) : (
        <div className="service-list">
          {items.length === 0 && <p>还没有记录。</p>}
          {items.map((item) => (
            <article className="service-card" key={item.id}>
              <h3>{item.id}</h3>
              <p>{item.status}</p>
              <div className="service-actions">
                <button disabled={busy} type="button" onClick={() => void openDetail(item.id)}>
                  查看
                </button>
                <button
                  disabled={busy}
                  type="button"
                  onClick={() => {
                    if (pendingDelete !== item.id) {
                      setPendingDelete(item.id);
                      return;
                    }
                    void run(() => api.deleteSession(item.id), "记录已删除").then(() => {
                      setPendingDelete(null);
                    });
                  }}
                >
                  {pendingDelete === item.id ? "确认删除" : "删除"}
                </button>
                {pendingDelete === item.id && (
                  <button disabled={busy} type="button" onClick={() => setPendingDelete(null)}>
                    取消
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
