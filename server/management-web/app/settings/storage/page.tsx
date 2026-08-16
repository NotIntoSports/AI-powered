"use client";

import { FormEvent, useEffect, useState } from "react";
import { ConsoleShell } from "../../console-shell";
import { useAdminSession } from "../../use-admin-session";
import {
  displayError,
  parseAPIError,
  requestJSON,
  type PublicStorageSettings,
  type StorageTestResult
} from "../../../lib/control-api";

export default function StorageSettingsPage() {
  const { me, error, setError } = useAdminSession();
  const [config, setConfig] = useState<PublicStorageSettings | null>(null);
  const [region, setRegion] = useState("ap-guangzhou");
  const [bucket, setBucket] = useState("");
  const [secretId, setSecretId] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [buckets, setBuckets] = useState<{ name: string; region: string }[]>([]);

  async function load() {
    const result = await requestJSON("/api/v1/admin/settings/storage");
    if (!result.response.ok) {
      setError(displayError(parseAPIError(result.body, "无法读取对象存储配置")));
      return;
    }
    const data = result.body as PublicStorageSettings;
    setConfig(data);
    if (data.region) setRegion(data.region);
    if (data.bucket) setBucket(data.bucket);
    if (data.secretId) setSecretId(data.secretId);
    setEnabled(data.enabled);
    setError("");
  }

  useEffect(() => {
    if (me) void load();
  }, [me]);

  function payload() {
    return {
      provider: "tencent-cos",
      region,
      bucket,
      secretId,
      enabled,
      ...(secretKey.trim() ? { secretKey: secretKey.trim() } : {})
    };
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const result = await requestJSON("/api/v1/admin/settings/storage", {
        method: "PUT",
        body: JSON.stringify(payload())
      });
      if (!result.response.ok) {
        setError(displayError(parseAPIError(result.body, "保存失败")));
        return;
      }
      const data = result.body as PublicStorageSettings;
      setConfig(data);
      setSecretKey("");
      setNotice(data.available ? "对象存储已写入数据库并可用。" : "已保存，但还需要 Bucket、地域和密钥后才能上传简历。");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const result = await requestJSON("/api/v1/admin/settings/storage/test", {
        method: "POST",
        body: JSON.stringify(payload())
      });
      const body = result.body as StorageTestResult;
      if (!result.response.ok) {
        setError(displayError(parseAPIError(result.body, "测试失败")));
        return;
      }
      setNotice(body.message);
      setBuckets(body.buckets || []);
      if (!bucket && body.buckets?.[0]) {
        setBucket(body.buckets[0].name);
        if (body.buckets[0].region) setRegion(body.buckets[0].region);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConsoleShell me={me}>
      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="ok">{notice}</p> : null}
      <form className="card" onSubmit={save} autoComplete="off">
        <h2>腾讯云 COS</h2>
        <p className="muted">
          SecretKey 使用服务器主密钥加密后写入 PostgreSQL，读取接口不会返回密钥。客户端只通过管理 API 上传，不会拿到云密钥。
          {config?.secretKeyConfigured ? " 当前已保存密钥。" : " 请填写 SecretId 和 SecretKey。"}
        </p>
        <label>
          SecretId
          <input value={secretId} onChange={(event) => setSecretId(event.target.value)} autoComplete="off" />
        </label>
        <label>
          SecretKey{config?.secretKeyConfigured ? "（留空则保留已保存密钥）" : ""}
          <input
            type="password"
            value={secretKey}
            onChange={(event) => setSecretKey(event.target.value)}
            autoComplete="new-password"
          />
        </label>
        <div className="row">
          <label>
            地域
            <input value={region} onChange={(event) => setRegion(event.target.value)} placeholder="例如 ap-guangzhou" />
          </label>
          <label>
            Bucket
            <input value={bucket} onChange={(event) => setBucket(event.target.value)} placeholder="例如 resume-1250000000" />
          </label>
          <label>
            启用
            <select value={enabled ? "yes" : "no"} onChange={(event) => setEnabled(event.target.value === "yes")}>
              <option value="yes">启用</option>
              <option value="no">停用</option>
            </select>
          </label>
        </div>
        <div className="row">
          <button type="submit" disabled={busy}>{busy ? "处理中…" : "保存到数据库"}</button>
          <button className="secondary" type="button" disabled={busy} onClick={() => void test()}>测试并列出 Bucket</button>
        </div>
        {buckets.length > 0 ? (
          <p className="muted">
            账号下的存储桶：{buckets.map((item) => `${item.name}（${item.region || "未知地域"}）`).join("、")}
          </p>
        ) : null}
        {config?.updatedAt ? (
          <p className="muted">版本 {config.configVersion} · {config.updatedByUsername || "未知"} · {config.updatedAt}</p>
        ) : null}
      </form>
    </ConsoleShell>
  );
}
