import { FormEvent, useCallback, useEffect, useState } from "react";

import * as api from "../../api/commands";
import type { CommandResult, PublicConfig, RoleProfileConfig } from "../../generated/bindings";

const errorText = (error: { code: string; message: string; field?: string | null }) =>
  `${error.field ? error.field + "：" : ""}${error.code}：${error.message}`;

const emptyRole = {
  id: "",
  name: "",
  systemPrompt: "",
  openingMessage: "",
  styleInstructions: "",
};

export function RoleEditor() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [message, setMessage] = useState("正在读取本地配置…");
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState(emptyRole);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [copyTargets, setCopyTargets] = useState<Record<string, string>>({});

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
        api.saveRoleProfile({
          id: role.id.trim(),
          name: role.name.trim(),
          systemPrompt: role.systemPrompt.trim(),
          openingMessage: role.openingMessage.trim(),
          styleInstructions: role.styleInstructions.trim(),
        }),
      "角色已保存",
    );
  }

  const profiles = config?.roleProfiles ?? [];

  return (
    <section className="service-panel role-editor" aria-labelledby="role-editor-heading">
      <h2 id="role-editor-heading">角色</h2>
      {message && (
        <p className="services-message" role="status">
          {message}
        </p>
      )}
      <form className="service-form" onSubmit={submit}>
        <label>
          角色 ID
          <input
            required
            maxLength={64}
            pattern="[a-z0-9_-]+"
            value={role.id}
            onChange={(event) => setRole({ ...role, id: event.target.value })}
          />
        </label>
        <label>
          显示名称
          <input
            required
            value={role.name}
            onChange={(event) => setRole({ ...role, name: event.target.value })}
          />
        </label>
        <label>
          系统提示
          <textarea
            maxLength={32 * 1024}
            value={role.systemPrompt}
            onChange={(event) => setRole({ ...role, systemPrompt: event.target.value })}
          />
        </label>
        <label>
          开场白
          <textarea
            maxLength={4 * 1024}
            value={role.openingMessage}
            onChange={(event) => setRole({ ...role, openingMessage: event.target.value })}
          />
        </label>
        <label>
          风格说明
          <textarea
            maxLength={8 * 1024}
            value={role.styleInstructions}
            onChange={(event) => setRole({ ...role, styleInstructions: event.target.value })}
          />
        </label>
        <button disabled={busy} type="submit">
          保存角色
        </button>
      </form>
      <div className="service-list">
        {profiles.length === 0 && <p>还没有角色。</p>}
        {profiles.map((item) => (
          <RoleCard
            key={item.id}
            item={item}
            busy={busy}
            pendingDelete={pendingDelete === item.id}
            copyTarget={copyTargets[item.id] ?? ""}
            onCopyTarget={(value) => setCopyTargets((current) => ({ ...current, [item.id]: value }))}
            onEdit={() =>
              setRole({
                id: item.id,
                name: item.name,
                systemPrompt: item.systemPrompt,
                openingMessage: item.openingMessage,
                styleInstructions: item.styleInstructions,
              })
            }
            onActivate={() => void run(() => api.activateRoleProfile(item.id), "默认角色已更新")}
            onCopy={() =>
              void run(
                () =>
                  api.copyRoleProfile({
                    sourceId: item.id,
                    id: (copyTargets[item.id] ?? "").trim(),
                  }),
                "角色已复制",
              )
            }
            onDelete={() => {
              if (pendingDelete !== item.id) {
                setPendingDelete(item.id);
                return;
              }
              void run(() => api.deleteRoleProfile(item.id), "角色已删除").then(() => {
                setPendingDelete(null);
              });
            }}
          />
        ))}
      </div>
    </section>
  );
}

function RoleCard(props: {
  item: RoleProfileConfig;
  busy: boolean;
  pendingDelete: boolean;
  copyTarget: string;
  onCopyTarget: (value: string) => void;
  onEdit: () => void;
  onActivate: () => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const { item } = props;
  return (
    <article className="service-card">
      <h3>{item.name}</h3>
      <p>{item.id}</p>
      {item.active && <strong>当前启用</strong>}
      {item.configVersion === 0 && <p>需复查后保存才能启用</p>}
      <div className="service-actions">
        <button aria-label={"编辑 " + item.name} disabled={props.busy} onClick={props.onEdit}>
          编辑
        </button>
        <button disabled={props.busy || item.configVersion === 0} onClick={props.onActivate}>
          设为默认
        </button>
        <label>
          复制为
          <input
            aria-label={"复制 " + item.id + " 的新 ID"}
            value={props.copyTarget}
            onChange={(event) => props.onCopyTarget(event.target.value)}
          />
        </label>
        <button disabled={props.busy || item.configVersion === 0} onClick={props.onCopy}>
          复制
        </button>
        <button disabled={props.busy} onClick={props.onDelete}>
          {props.pendingDelete ? "确认删除" : "删除"}
        </button>
      </div>
    </article>
  );
}
