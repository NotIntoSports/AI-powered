"use client";

import { FormEvent, useEffect, useState } from "react";
import { ConsoleShell, formatTime } from "../../console-shell";
import { useAdminSession } from "../../use-admin-session";
import {
  displayError,
  parseAPIError,
  requestJSON,
  type AITestResult,
  type CatalogSyncResult,
  type DiscoveredModel,
  type PublicAIProvider
} from "../../../lib/control-api";
import { ConfigStatus, SecretField } from "../config-status";

const DEFAULT_BASE_URL = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";

type ProviderDraft = {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  enabled: boolean;
  questionTimeoutMs: number;
  reportTimeoutMs: number;
};

function hostLabel(baseUrl: string) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl || "未填写";
  }
}

function emptyDraft(): ProviderDraft {
  return {
    name: "新 AI 线路",
    baseUrl: DEFAULT_BASE_URL,
    model: "",
    apiKey: "",
    enabled: true,
    questionTimeoutMs: 60000,
    reportTimeoutMs: 180000
  };
}

function draftFromProvider(provider: PublicAIProvider): ProviderDraft {
  return {
    name: provider.name || "OpenAI 兼容",
    baseUrl: provider.baseUrl || DEFAULT_BASE_URL,
    model: provider.model || "",
    apiKey: "",
    enabled: provider.enabled,
    questionTimeoutMs: provider.questionTimeoutMs || 60000,
    reportTimeoutMs: provider.reportTimeoutMs || 180000
  };
}

function providerPayload(draft: ProviderDraft, includeKey: boolean) {
  return {
    name: draft.name,
    provider: "openai-compatible",
    baseUrl: draft.baseUrl,
    model: draft.model.trim(),
    questionTimeoutMs: draft.questionTimeoutMs,
    reportTimeoutMs: draft.reportTimeoutMs,
    enabled: draft.enabled,
    ...(includeKey && draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {})
  };
}

export default function AISettingsPage() {
  const { me, error, setError } = useAdminSession();
  const [providers, setProviders] = useState<PublicAIProvider[]>([]);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, DiscoveredModel[]>>({});
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({});
  const [newDraft, setNewDraft] = useState<ProviderDraft>(emptyDraft());
  const [showNewForm, setShowNewForm] = useState(false);
  const [manualModelId, setManualModelId] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState("");
  const [discoveringId, setDiscoveringId] = useState("");
  const [syncing, setSyncing] = useState(false);

  async function syncCatalog() {
    setSyncing(true);
    setError("");
    setNotice("");
    try {
      const result = await requestJSON("/api/v1/admin/settings/catalog/sync", { method: "POST" });
      if (!result.response.ok) {
        setError(displayError(parseAPIError(result.body, "同步识别失败")));
        return;
      }
      const body = result.body as CatalogSyncResult;
      setNotice(`已同步 ${body.providers} 条线路、${body.models} 个模型，新识别 ${body.classified} 个。`);
      await load();
    } finally {
      setSyncing(false);
    }
  }

  async function loadProviderModels(providerId: string) {
    const result = await requestJSON(`/api/v1/admin/settings/ai/providers/${encodeURIComponent(providerId)}/models`);
    if (!result.response.ok) {
      setError(displayError(parseAPIError(result.body, "无法加载模型列表")));
      return;
    }
    setModelsByProvider((current) => ({ ...current, [providerId]: result.body as DiscoveredModel[] }));
  }

  async function load() {
    const result = await requestJSON("/api/v1/admin/settings/ai/providers");
    if (!result.response.ok) {
      setError(displayError(parseAPIError(result.body, "无法读取 AI 配置")));
      return;
    }
    const list = result.body as PublicAIProvider[];
    setProviders(list);
    const nextDrafts: Record<string, ProviderDraft> = {};
    for (const provider of list) {
      nextDrafts[provider.id] = drafts[provider.id] ?? draftFromProvider(provider);
    }
    setDrafts(nextDrafts);
    setError("");
    await Promise.all(list.map((provider) => loadProviderModels(provider.id)));
  }

  useEffect(() => {
    if (me) void load();
  }, [me]);

  function updateDraft(providerId: string, patch: Partial<ProviderDraft>) {
    setDrafts((current) => ({
      ...current,
      [providerId]: { ...(current[providerId] ?? emptyDraft()), ...patch }
    }));
  }

  async function createProvider(event: FormEvent) {
    event.preventDefault();
    setBusyId("new");
    setNotice("");
    setError("");
    try {
      const result = await requestJSON("/api/v1/admin/settings/ai/providers", {
        method: "POST",
        body: JSON.stringify(providerPayload(newDraft, true))
      });
      if (!result.response.ok) {
        setError(displayError(parseAPIError(result.body, "创建失败")));
        return;
      }
      setNotice("已新增 AI 线路。");
      setShowNewForm(false);
      setNewDraft(emptyDraft());
      await load();
    } finally {
      setBusyId("");
    }
  }

  async function saveProvider(providerId: string) {
    const draft = drafts[providerId];
    if (!draft?.model.trim()) {
      setError("请先选择或填写模型 ID");
      return;
    }
    setBusyId(providerId);
    setNotice("");
    setError("");
    try {
      const result = await requestJSON(`/api/v1/admin/settings/ai/providers/${encodeURIComponent(providerId)}`, {
        method: "PUT",
        body: JSON.stringify(providerPayload(draft, true))
      });
      if (!result.response.ok) {
        setError(displayError(parseAPIError(result.body, "保存失败")));
        return;
      }
      setNotice("AI 线路已保存。");
      await load();
    } finally {
      setBusyId("");
    }
  }

  async function deleteProvider(provider: PublicAIProvider) {
    if (!window.confirm(`确定删除线路「${provider.name}」？`)) return;
    setBusyId(provider.id);
    setNotice("");
    setError("");
    try {
      const result = await requestJSON(`/api/v1/admin/settings/ai/providers/${encodeURIComponent(provider.id)}`, {
        method: "DELETE"
      });
      if (!result.response.ok) {
        setError(displayError(parseAPIError(result.body, "删除失败")));
        return;
      }
      setNotice(`已删除：${provider.name}`);
      await load();
    } finally {
      setBusyId("");
    }
  }

  async function activateProvider(providerId: string) {
    setBusyId(providerId);
    setNotice("");
    setError("");
    try {
      const result = await requestJSON(`/api/v1/admin/settings/ai/providers/${encodeURIComponent(providerId)}/activate`, {
        method: "POST"
      });
      if (!result.response.ok) {
        setError(displayError(parseAPIError(result.body, "设为默认失败")));
        return;
      }
      setNotice("已设为默认 AI 线路。");
      await load();
    } finally {
      setBusyId("");
    }
  }

  async function testProvider(providerId: string) {
    const draft = drafts[providerId];
    if (!draft) return;
    setBusyId(providerId);
    setNotice("");
    setError("");
    try {
      const result = await requestJSON(`/api/v1/admin/settings/ai/providers/${encodeURIComponent(providerId)}/test`, {
        method: "POST",
        body: JSON.stringify(providerPayload(draft, true))
      });
      const body = result.body as AITestResult;
      if (!result.response.ok) {
        setError(displayError(parseAPIError(result.body, "测试失败")));
        return;
      }
      setNotice(body.message);
    } finally {
      setBusyId("");
    }
  }

  async function discoverProvider(providerId: string) {
    const draft = drafts[providerId];
    if (!draft) return;
    setDiscoveringId(providerId);
    setNotice("");
    setError("");
    try {
      const result = await requestJSON(`/api/v1/admin/settings/ai/providers/${encodeURIComponent(providerId)}/discover`, {
        method: "POST",
        body: JSON.stringify({
          baseUrl: draft.baseUrl,
          ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {})
        })
      });
      if (!result.response.ok) {
        setError(displayError(parseAPIError(result.body, "发现模型失败")));
        return;
      }
      const discovered = result.body as DiscoveredModel[];
      setModelsByProvider((current) => ({ ...current, [providerId]: discovered }));
      setNotice(`发现 ${discovered.length} 个模型。`);
      if (!draft.model.trim() && discovered.length > 0) {
        updateDraft(providerId, { model: discovered[0].modelId });
      }
    } finally {
      setDiscoveringId("");
    }
  }

  async function toggleModel(providerId: string, model: DiscoveredModel) {
    setError("");
    setNotice("");
    const result = await requestJSON(
      `/api/v1/admin/settings/ai/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(model.modelId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ enabled: !model.enabled })
      }
    );
    if (!result.response.ok) {
      setError(displayError(parseAPIError(result.body, "操作失败")));
      return;
    }
    await loadProviderModels(providerId);
  }

  async function activateModel(providerId: string, modelId: string) {
    setBusyId(providerId);
    setNotice("");
    setError("");
    try {
      const result = await requestJSON(
        `/api/v1/admin/settings/ai/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}/activate`,
        { method: "POST" }
      );
      if (!result.response.ok) {
        setError(displayError(parseAPIError(result.body, "设置当前模型失败")));
        return;
      }
      setNotice(`已设为当前模型：${modelId}`);
      await load();
    } finally {
      setBusyId("");
    }
  }

  async function addManualModel(providerId: string) {
    const modelId = (manualModelId[providerId] || "").trim();
    if (!modelId) return;
    setError("");
    setNotice("");
    const result = await requestJSON(`/api/v1/admin/settings/ai/providers/${encodeURIComponent(providerId)}/models`, {
      method: "POST",
      body: JSON.stringify({ modelId })
    });
    if (!result.response.ok) {
      setError(displayError(parseAPIError(result.body, "添加模型失败")));
      return;
    }
    setManualModelId((current) => ({ ...current, [providerId]: "" }));
    setNotice(`已添加模型：${modelId}`);
    await loadProviderModels(providerId);
  }

  async function deleteModel(providerId: string, modelId: string) {
    if (!window.confirm(`确定从列表移除模型「${modelId}」？`)) return;
    const result = await requestJSON(
      `/api/v1/admin/settings/ai/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`,
      { method: "DELETE" }
    );
    if (!result.response.ok) {
      setError(displayError(parseAPIError(result.body, "删除模型失败")));
      return;
    }
    await loadProviderModels(providerId);
  }

  const defaultProvider = providers.find((provider) => provider.isDefault);

  return (
    <ConsoleShell me={me}>
      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="ok">{notice}</p> : null}

      <section className="card">
        <div className="card-head">
          <h2>模型管理</h2>
          <ConfigStatus
            ready={Boolean(defaultProvider?.available)}
            readyText={defaultProvider ? `默认 · ${defaultProvider.name}` : "未设默认线路"}
            waitText="尚未配齐默认线路"
          />
        </div>
        <p className="muted">
          可保存多条 OpenAI 兼容线路（如 TOKENPLAN、DeepSeek）。客户端使用「默认」线路。「同步并识别」会拉取全部密钥的模型并自动标注 ASR/LLM/TTS/端对端。
        </p>
        <div className="status-grid">
          {providers.length === 0 ? (
            <div className="status-chip">
              <strong>暂无线路</strong>
              <span>点击下方新增</span>
            </div>
          ) : (
            providers.map((provider) => (
              <div key={provider.id} className={`status-chip ${provider.available ? "ready" : ""}`}>
                <strong>{provider.name}{provider.isDefault ? " · 默认" : ""}</strong>
                <span>
                  {provider.available
                    ? `${hostLabel(provider.baseUrl)} · ${provider.model || "未选模型"}`
                    : provider.apiKeyConfigured
                      ? `${hostLabel(provider.baseUrl)} · 待补全`
                      : "未配置密钥"}
                </span>
              </div>
            ))
          )}
        </div>
        <div className="row">
          <button className="secondary" type="button" disabled={syncing || Boolean(busyId)} onClick={() => void syncCatalog()}>
            {syncing ? "同步中…" : "同步并识别全部模型"}
          </button>
          <button className="secondary" type="button" onClick={() => setShowNewForm((value) => !value)}>
            {showNewForm ? "取消新增" : "新增线路"}
          </button>
        </div>
      </section>

      {showNewForm ? (
        <form className="card config-details" onSubmit={createProvider}>
          <div className="stack">
            <h3>新增 AI 线路</h3>
            <label>
              名称
              <input value={newDraft.name} onChange={(event) => setNewDraft({ ...newDraft, name: event.target.value })} required />
            </label>
            <label>
              Base URL
              <input value={newDraft.baseUrl} onChange={(event) => setNewDraft({ ...newDraft, baseUrl: event.target.value })} required />
            </label>
            <label>
              模型 ID（可留空，发现后选择）
              <input value={newDraft.model} onChange={(event) => setNewDraft({ ...newDraft, model: event.target.value })} />
            </label>
            <SecretField label="API Key" configured={false} value={newDraft.apiKey} onChange={(value) => setNewDraft({ ...newDraft, apiKey: value })} />
            <button type="submit" disabled={busyId === "new"}>{busyId === "new" ? "创建中…" : "创建线路"}</button>
          </div>
        </form>
      ) : null}

      {providers.map((provider) => {
        const draft = drafts[provider.id] ?? draftFromProvider(provider);
        const models = modelsByProvider[provider.id] ?? [];
        const busy = busyId === provider.id;
        const discovering = discoveringId === provider.id;
        return (
          <details key={provider.id} className="card config-details" open={!provider.available || provider.isDefault}>
            <summary>
              <span>
                {provider.name} · {hostLabel(provider.baseUrl)}
                {provider.model ? ` · ${provider.model}` : ""}
              </span>
              <ConfigStatus
                ready={provider.available}
                readyText={provider.isDefault ? "默认 · 已连通" : "已连通"}
                waitText={provider.isDefault ? "默认 · 未就绪" : "未就绪"}
              />
            </summary>
            <div className="stack">
              <label>
                名称
                <input value={draft.name} onChange={(event) => updateDraft(provider.id, { name: event.target.value })} />
              </label>
              <label>
                Base URL
                <input value={draft.baseUrl} onChange={(event) => updateDraft(provider.id, { baseUrl: event.target.value })} required />
              </label>
              <label>
                模型 ID
                <input
                  value={draft.model}
                  onChange={(event) => updateDraft(provider.id, { model: event.target.value })}
                  list={`models-${provider.id}`}
                />
                <datalist id={`models-${provider.id}`}>
                  {models.map((model) => (
                    <option key={model.id} value={model.modelId} />
                  ))}
                </datalist>
              </label>
              <SecretField
                label="API Key"
                configured={provider.apiKeyConfigured}
                value={draft.apiKey}
                onChange={(value) => updateDraft(provider.id, { apiKey: value })}
              />
              <div className="row">
                <label>
                  追问超时（毫秒）
                  <input type="number" min={1000} max={600000} value={draft.questionTimeoutMs} onChange={(event) => updateDraft(provider.id, { questionTimeoutMs: Number(event.target.value) })} />
                </label>
                <label>
                  报告超时（毫秒）
                  <input type="number" min={1000} max={600000} value={draft.reportTimeoutMs} onChange={(event) => updateDraft(provider.id, { reportTimeoutMs: Number(event.target.value) })} />
                </label>
                <label>
                  启用
                  <select value={draft.enabled ? "yes" : "no"} onChange={(event) => updateDraft(provider.id, { enabled: event.target.value === "yes" })}>
                    <option value="yes">启用</option>
                    <option value="no">停用</option>
                  </select>
                </label>
              </div>
              <div className="row">
                <button type="button" disabled={busy} onClick={() => void saveProvider(provider.id)}>
                  {busy ? "处理中…" : "保存"}
                </button>
                <button className="secondary" type="button" disabled={busy} onClick={() => void testProvider(provider.id)}>测试连接</button>
                <button className="secondary" type="button" disabled={discovering || busy} onClick={() => void discoverProvider(provider.id)}>
                  {discovering ? "发现中…" : "发现可用模型"}
                </button>
                {!provider.isDefault ? (
                  <button className="secondary" type="button" disabled={busy} onClick={() => void activateProvider(provider.id)}>设为默认</button>
                ) : null}
                <button className="secondary" type="button" disabled={busy || providers.length <= 1} onClick={() => void deleteProvider(provider)}>
                  删除线路
                </button>
              </div>

              <details className="config-details nested-details" open={models.length > 0}>
                <summary>
                  <span>已发现模型（{models.length} 个）</span>
                </summary>
                <div className="stack">
                  <div className="row">
                    <label style={{ flex: 1 }}>
                      手动添加模型 ID
                      <input
                        value={manualModelId[provider.id] || ""}
                        onChange={(event) => setManualModelId((current) => ({ ...current, [provider.id]: event.target.value }))}
                        placeholder="例如 qwen3.7-plus"
                      />
                    </label>
                    <button className="secondary" type="button" onClick={() => void addManualModel(provider.id)}>添加</button>
                  </div>
                  {models.length === 0 ? (
                    <p className="muted">暂无模型，请先发现或手动添加。</p>
                  ) : (
                    <table>
                      <thead>
                        <tr>
                          <th>模型 ID</th>
                          <th>拥有者</th>
                          <th>发现时间</th>
                          <th>状态</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {models.map((model) => (
                          <tr key={model.id} style={{ background: provider.model === model.modelId ? "#1a2233" : undefined }}>
                            <td>{model.modelId}</td>
                            <td className="muted">{model.ownedBy || "—"}</td>
                            <td className="muted">{formatTime(model.discoveredAt)}</td>
                            <td>
                              <span className={model.enabled ? "online" : "offline"}>
                                {model.enabled ? "已启用" : "已禁用"}
                              </span>
                            </td>
                            <td>
                              <div className="row">
                                <button className="secondary" type="button" onClick={() => void toggleModel(provider.id, model)}>
                                  {model.enabled ? "禁用" : "启用"}
                                </button>
                                {provider.model !== model.modelId ? (
                                  <button className="secondary" type="button" disabled={busy} onClick={() => void activateModel(provider.id, model.modelId)}>
                                    设为当前
                                  </button>
                                ) : (
                                  <span className="muted" style={{ fontSize: 12, lineHeight: "32px" }}>当前</span>
                                )}
                                <button className="secondary" type="button" onClick={() => void deleteModel(provider.id, model.modelId)}>删除</button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </details>

              {provider.updatedAt ? (
                <p className="muted">版本 {provider.configVersion} · {provider.updatedByUsername || "未知"} · {provider.updatedAt}</p>
              ) : null}
            </div>
          </details>
        );
      })}
    </ConsoleShell>
  );
}
