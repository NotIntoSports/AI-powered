import { FormEvent, useCallback, useEffect, useState } from "react";

import * as api from "../../api/commands";
import type { CommandResult, PublicConfig } from "../../generated/bindings";

const errorText = (error: { code: string; message: string; field?: string | null }) =>
  `${error.field ? error.field + "：" : ""}${error.code}：${error.message}`;

const emptyEmbedding = {
  id: "",
  providerId: "",
  modelId: "",
  dimensions: "1536",
  normalized: true,
};

export function EmbeddingEditor() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [message, setMessage] = useState("正在读取本地配置…");
  const [busy, setBusy] = useState(false);
  const [embedding, setEmbedding] = useState(emptyEmbedding);

  const reload = useCallback(async () => {
    try {
      const result = await api.getConfigPublic();
      if (result.ok) {
        setConfig(result.data);
        setMessage("");
      } else {
        setMessage(errorText(result.error));
      }
    } catch {
      setMessage("IPC_UNAVAILABLE：无法读取本地配置");
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

  async function submit(event: FormEvent) {
    event.preventDefault();
    await run(
      () =>
        api.saveEmbeddingConfig({
          id: embedding.id.trim(),
          providerId: embedding.providerId.trim(),
          modelId: embedding.modelId.trim(),
          dimensions: Number(embedding.dimensions),
          normalized: embedding.normalized,
        }),
      "Embedding 配置已保存，请先测试再启用",
    );
  }

  const providers = config?.models.providers ?? [];
  const items = config?.knowledge.embeddingConfigs ?? [];

  return (
    <section className="service-panel embedding-editor" aria-labelledby="embedding-editor-heading">
      <h2 id="embedding-editor-heading">Embedding</h2>
      <p>测试、切片和查询文本会发送到所选供应商的 Embedding 接口，不会经过作者服务器。</p>
      {message && (
        <p className="services-message" role="status">
          {message}
        </p>
      )}
      <form className="service-form" onSubmit={submit}>
        <label>
          配置 ID
          <input
            required
            pattern="[a-z0-9_-]+"
            value={embedding.id}
            onChange={(event) => setEmbedding({ ...embedding, id: event.target.value })}
          />
        </label>
        <label>
          供应商
          <select
            required
            value={embedding.providerId}
            onChange={(event) => setEmbedding({ ...embedding, providerId: event.target.value })}
          >
            <option value="">请选择</option>
            {providers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name || item.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          模型
          <input
            required
            value={embedding.modelId}
            onChange={(event) => setEmbedding({ ...embedding, modelId: event.target.value })}
          />
        </label>
        <label>
          维度
          <input
            required
            type="number"
            min={1}
            max={65536}
            value={embedding.dimensions}
            onChange={(event) => setEmbedding({ ...embedding, dimensions: event.target.value })}
          />
        </label>
        <label>
          距离
          <input readOnly value="cosine" />
        </label>
        <label>
          <input
            type="checkbox"
            checked={embedding.normalized}
            onChange={(event) => setEmbedding({ ...embedding, normalized: event.target.checked })}
          />
          归一化向量
        </label>
        <button disabled={busy || providers.length === 0} type="submit">
          保存 Embedding
        </button>
      </form>
      <div className="service-list">
        {items.length === 0 && <p>还没有 Embedding 配置。</p>}
        {items.map((item) => (
          <article className="service-card" key={item.id}>
            <h3>{item.id}</h3>
            <p>
              {item.providerId} · {item.modelId} · {item.dimensions} 维 · cosine
            </p>
            <p>{item.ready ? "测试通过" : "尚未就绪"}</p>
            {item.active && <strong>当前启用</strong>}
            <div className="service-actions">
              <button
                aria-label={"编辑 " + item.id}
                disabled={busy}
                onClick={() =>
                  setEmbedding({
                    id: item.id,
                    providerId: item.providerId,
                    modelId: item.modelId,
                    dimensions: String(item.dimensions),
                    normalized: item.normalized,
                  })
                }
              >
                编辑
              </button>
              <button disabled={busy} onClick={() => void run(() => api.testEmbeddingConfig(item.id), "Embedding 测试通过")}>
                测试
              </button>
              <button
                disabled={busy || !item.ready}
                onClick={() => void run(() => api.activateEmbeddingConfig(item.id), "Embedding 已启用")}
              >
                启用
              </button>
              <button disabled={busy} onClick={() => void run(() => api.deleteEmbeddingConfig(item.id), "Embedding 已删除")}>
                删除
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
