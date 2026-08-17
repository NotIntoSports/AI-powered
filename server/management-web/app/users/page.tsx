"use client";

import { FormEvent, useEffect, useState } from "react";
import { ConsoleShell, OnlineMark, formatTime } from "../console-shell";
import { useAdminSession } from "../use-admin-session";
import {
  displayError,
  parseAPIError,
  publicUserFromUnknown,
  requestJSON,
  type PublicUser
} from "../../lib/control-api";

export default function UsersPage() {
  const { me, error, setError } = useAdminSession();
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [notice, setNotice] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"operator" | "admin">("operator");
  const [busy, setBusy] = useState(false);

  async function load() {
    const listResult = await requestJSON("/api/v1/admin/users");
    if (!listResult.response.ok) {
      setError(displayError(parseAPIError(listResult.body, "无法加载用户")));
      return;
    }
    const listed = Array.isArray(listResult.body)
      ? listResult.body.map(publicUserFromUnknown).filter((user): user is PublicUser => Boolean(user))
      : [];
    setUsers(listed);
    setError("");
  }

  useEffect(() => {
    if (!me) return;
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [me]);

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const { response, body } = await requestJSON("/api/v1/admin/users", {
        method: "POST",
        body: JSON.stringify({ username, password, role })
      });
      if (!response.ok) {
        setError(displayError(parseAPIError(body, "创建失败")));
        return;
      }
      setUsername("");
      setPassword("");
      setNotice("已创建用户");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(user: PublicUser, status: "active" | "disabled") {
    setError("");
    setNotice("");
    const { response, body } = await requestJSON(`/api/v1/admin/users/${user.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status })
    });
    if (!response.ok) {
      setError(displayError(parseAPIError(body, "更新状态失败")));
      return;
    }
    await load();
  }

  async function resetPassword(user: PublicUser) {
    const nextPassword = window.prompt(`为 ${user.username} 设置新密码（至少 8 个字符）`);
    if (!nextPassword) {
      return;
    }
    setError("");
    setNotice("");
    const { response, body } = await requestJSON(`/api/v1/admin/users/${user.id}/reset-password`, {
      method: "POST",
      body: JSON.stringify({ password: nextPassword })
    });
    if (!response.ok) {
      setError(displayError(parseAPIError(body, "重置密码失败")));
      return;
    }
    setNotice(`已重置 ${user.username} 的密码并撤销其会话`);
    await load();
  }

  async function revokeSessions(user: PublicUser) {
    setError("");
    setNotice("");
    const preserveCurrent = me?.id === user.id;
    const { response, body } = await requestJSON(`/api/v1/admin/users/${user.id}/revoke-sessions`, {
      method: "POST",
      body: JSON.stringify({ preserveCurrent })
    });
    if (!response.ok) {
      setError(displayError(parseAPIError(body, "撤销会话失败")));
      return;
    }
    setNotice(preserveCurrent ? "已撤销其他会话，当前登录保留" : `已撤销 ${user.username} 的全部会话`);
  }

  function canDisable(user: PublicUser) {
    if (me?.id === user.id) return false;
    if (user.status !== "active") return false;
    if (user.role === "admin") {
      const activeAdmins = users.filter((item) => item.role === "admin" && item.status === "active");
      if (activeAdmins.length <= 1) return false;
    }
    return true;
  }

  return (
    <ConsoleShell me={me}>
      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="ok">{notice}</p> : null}

      <form className="card" onSubmit={onCreate} autoComplete="off">
        <h2>创建用户</h2>
        <div className="row">
          <label>
            用户名
            <input value={username} onChange={(event) => setUsername(event.target.value)} required />
          </label>
          <label>
            初始密码
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={8}
              required
            />
          </label>
          <label>
            角色
            <select value={role} onChange={(event) => setRole(event.target.value as "operator" | "admin")}>
              <option value="operator">客户端</option>
              <option value="admin">管理员</option>
            </select>
          </label>
        </div>
        <button type="submit" disabled={busy}>
          创建
        </button>
        <p className="muted">不会公开注册。客户端账号给 Windows 客户端登录，不能进入本后台。管理员账号只用于网页后台。</p>
      </form>

      <section className="card">
        <h2>现有用户</h2>
        <table>
          <thead>
            <tr>
              <th>用户名</th>
              <th>角色</th>
              <th>状态</th>
              <th>在线</th>
              <th>语音绑定</th>
              <th>音色 ID</th>
              <th>绑定时间</th>
              <th>最后登录</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>{user.username}</td>
                <td>{user.role === "admin" ? "管理员" : "客户端"}</td>
                <td>{user.status === "active" ? "启用" : user.status === "disabled" ? "停用" : user.status}</td>
                <td><OnlineMark online={Boolean(user.online)} /></td>
                <td>{user.voiceBound ? "已绑定" : "未绑定"}</td>
                <td>{user.speakerId || "—"}</td>
                <td>{formatTime(user.voiceBoundAt)}</td>
                <td>{formatTime(user.lastLoginAt)}</td>
                <td className="row">
                  {user.status === "active" ? (
                    canDisable(user) ? (
                      <button className="danger" type="button" onClick={() => void setStatus(user, "disabled")}>
                        禁用
                      </button>
                    ) : (
                      <span className="muted">{me?.id === user.id ? "当前登录" : "最后一位管理员"}</span>
                    )
                  ) : (
                    <button className="secondary" type="button" onClick={() => void setStatus(user, "active")}>
                      启用
                    </button>
                  )}
                  <button className="secondary" type="button" onClick={() => void resetPassword(user)}>
                    重置密码
                  </button>
                  <button className="secondary" type="button" onClick={() => void revokeSessions(user)}>
                    撤销会话
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </ConsoleShell>
  );
}
