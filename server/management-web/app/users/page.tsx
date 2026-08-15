"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  displayError,
  parseAPIError,
  publicUserFromUnknown,
  requestJSON,
  type PublicUser
} from "../../lib/control-api";

export default function UsersPage() {
  const router = useRouter();
  const [me, setMe] = useState<PublicUser | null>(null);
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"operator" | "admin">("operator");
  const [busy, setBusy] = useState(false);

  async function load() {
    const meResult = await requestJSON("/api/v1/auth/me");
    if (meResult.response.status === 401) {
      router.replace("/login");
      return;
    }
    const current = publicUserFromUnknown(meResult.body);
    if (!current || current.role !== "admin") {
      setError("需要管理员账号才能进入管理后台");
      setMe(current);
      return;
    }
    setMe(current);
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
    void load();
  }, []);

  async function logout() {
    await requestJSON("/api/v1/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

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
    const nextPassword = window.prompt(`为 ${user.username} 设置新密码（至少 12 个字符）`);
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

  return (
    <main className="shell">
      <div className="topbar">
        <div>
          <p className="eyebrow">CONTROL API</p>
          <h1>用户管理</h1>
        </div>
        <div>
          <p className="muted">{me ? `${me.username} · ${me.role}` : ""}</p>
          <button className="secondary" type="button" onClick={() => void logout()}>
            退出
          </button>
        </div>
      </div>

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
              minLength={12}
              required
            />
          </label>
          <label>
            角色
            <select value={role} onChange={(event) => setRole(event.target.value as "operator" | "admin")}>
              <option value="operator">operator</option>
              <option value="admin">admin</option>
            </select>
          </label>
        </div>
        <button type="submit" disabled={busy}>
          创建
        </button>
        <p className="muted">不会公开注册。operator 供 Windows 客户端使用，不能进入本后台。</p>
      </form>

      <section className="card">
        <h2>现有用户</h2>
        <table>
          <thead>
            <tr>
              <th>用户名</th>
              <th>角色</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>{user.username}</td>
                <td>{user.role}</td>
                <td>{user.status}</td>
                <td className="row">
                  {user.status === "active" ? (
                    <button className="danger" type="button" onClick={() => void setStatus(user, "disabled")}>
                      禁用
                    </button>
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
    </main>
  );
}
