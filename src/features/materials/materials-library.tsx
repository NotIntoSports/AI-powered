import { FormEvent, useCallback, useEffect, useState } from "react";

import * as api from "../../api/commands";
import type { CommandResult, MaterialSearchHit, MaterialSummary } from "../../generated/bindings";

const errorText = (error: { code: string; message: string; field?: string | null }) =>
  `${error.field ? error.field + "：" : ""}${error.code}：${error.message}`;

export interface MaterialsLibraryProps {
  selectPath?: () => Promise<string | null>;
}

export function MaterialsLibrary({ selectPath }: MaterialsLibraryProps) {
  const [items, setItems] = useState<MaterialSummary[]>([]);
  const [hits, setHits] = useState<MaterialSearchHit[]>([]);
  const [message, setMessage] = useState("正在读取本地资料…");
  const [busy, setBusy] = useState(false);
  const [path, setPath] = useState("");
  const [query, setQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const result = await api.listMaterials();
      if (result.ok) {
        setItems(result.data);
        setMessage("");
      } else {
        setMessage(errorText(result.error));
      }
    } catch {
      setMessage("IPC_UNAVAILABLE：无法读取本地资料");
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

  async function submitImport(event: FormEvent) {
    event.preventDefault();
    await run(() => api.importMaterial(path.trim()), "资料已导入");
  }

  async function submitSearch(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.searchMaterials(query.trim());
      if (!result.ok) {
        setMessage(errorText(result.error));
        return;
      }
      setHits(result.data);
      setMessage("");
    } catch {
      setMessage("IPC_UNAVAILABLE：本地操作失败");
    } finally {
      setBusy(false);
    }
  }

  async function pickPath() {
    if (!selectPath) return;
    const picked = await selectPath();
    if (picked) setPath(picked);
  }

  return (
    <section className="service-panel materials-library" aria-labelledby="materials-library-heading">
      <h2 id="materials-library-heading">资料库</h2>
      {message && (
        <p className="services-message" role="status">
          {message}
        </p>
      )}
      <form className="service-form" onSubmit={submitImport}>
        <label>
          文件路径
          <input type="text" value={path} onChange={(event) => setPath(event.target.value)} />
        </label>
        {selectPath && (
          <button disabled={busy} type="button" onClick={() => void pickPath()}>
            选择文件
          </button>
        )}
        <button disabled={busy} type="submit">
          导入
        </button>
      </form>
      <form className="service-form" onSubmit={submitSearch}>
        <label>
          检索词
          <input value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <button disabled={busy} type="submit">
          搜索
        </button>
      </form>
      {hits.length > 0 && (
        <div className="service-list" aria-label="检索结果">
          {hits.map((item) => (
            <article className="service-card" key={item.chunkId}>
              <h3>{item.fileName}</h3>
              <p>{item.section}</p>
              <p>{item.snippet}</p>
            </article>
          ))}
        </div>
      )}
      <div className="service-list">
        {items.length === 0 && <p>还没有资料。</p>}
        {items.map((item) => (
          <article className="service-card" key={item.id}>
            <h3>{item.fileName}</h3>
            <p>{item.status}</p>
            <p>切片 {item.chunkCount}</p>
            <div className="service-actions">
              <button
                disabled={busy}
                onClick={() => {
                  if (pendingDelete !== item.id) {
                    setPendingDelete(item.id);
                    return;
                  }
                  void run(() => api.deleteMaterial(item.id), "资料已删除").then(() => {
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
    </section>
  );
}
