"use client";

import { FormEvent, useEffect, useState } from "react";
import { ConsoleShell } from "../../console-shell";
import { useAdminSession } from "../../use-admin-session";
import { displayError, parseAPIError, requestJSON } from "../../../lib/control-api";

type RoleProfile = { role: string; openingTemplate: string; closingTemplate: string; instructions: string; configVersion: number; updatedAt: string };
const labels: Record<string, string> = { hr: "HR", meeting_assistant: "会议助手", interviewer: "面试官", candidate: "应聘者" };

export default function RoleSettingsPage() {
  const { me, error, setError } = useAdminSession();
  const [roles, setRoles] = useState<RoleProfile[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const result = await requestJSON("/api/v1/admin/settings/roles");
    if (!result.response.ok) { setError(displayError(parseAPIError(result.body, "无法读取角色话术"))); return; }
    setRoles((result.body as { roles: RoleProfile[] }).roles || []); setError("");
  }
  useEffect(() => { if (me) void load(); }, [me]);

  function update(index: number, field: keyof RoleProfile, value: string) {
    setRoles((current) => current.map((role, itemIndex) => itemIndex === index ? { ...role, [field]: value } : role));
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const result = await requestJSON("/api/v1/admin/settings/roles", { method: "PUT", body: JSON.stringify({ roles: roles.map(({ role, openingTemplate, closingTemplate, instructions }) => ({ role, openingTemplate, closingTemplate, instructions })) }) });
      if (!result.response.ok) { setError(displayError(parseAPIError(result.body, "保存失败，请检查长度和模板占位符"))); return; }
      setRoles((result.body as { roles: RoleProfile[] }).roles || []); setNotice("四个角色的话术已保存，新会话将使用新版本。");
    } finally { setBusy(false); }
  }

  return <ConsoleShell me={me}>
    {error ? <p className="error">{error}</p> : null}{notice ? <p className="ok">{notice}</p> : null}
    <form className="card" onSubmit={save}>
      <div className="card-head"><h2>角色话术</h2></div>
      <p className="muted">开场和结束仅支持 {"{{target}}"}、{"{{topic}}"}。固定安全规则由程序追加，不能在这里覆盖；修改只影响之后开始的新会话。</p>
      {roles.map((role, index) => <fieldset key={role.role}>
        <legend>{labels[role.role] || role.role}</legend>
        <label>开场白<textarea value={role.openingTemplate} maxLength={500} onChange={(event) => update(index, "openingTemplate", event.target.value)} /></label>
        <label>结束语<textarea value={role.closingTemplate} maxLength={500} onChange={(event) => update(index, "closingTemplate", event.target.value)} /></label>
        <label>角色业务规则<textarea value={role.instructions} maxLength={4000} onChange={(event) => update(index, "instructions", event.target.value)} /></label>
        <p className="muted">版本 {role.configVersion}{role.updatedAt ? ` · ${role.updatedAt}` : ""}</p>
      </fieldset>)}
      <button type="submit" disabled={busy || roles.length !== 4}>{busy ? "保存中…" : "保存四个角色"}</button>
    </form>
  </ConsoleShell>;
}
