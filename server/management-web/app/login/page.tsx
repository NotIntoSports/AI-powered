"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { buildLoginBody, displayError, parseAPIError, publicUserFromUnknown, requestJSON } from "../../lib/control-api";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { response, body } = await requestJSON("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify(buildLoginBody(username, password))
      });
      if (!response.ok) {
        setError(displayError(parseAPIError(body, "登录失败")));
        return;
      }
      const payload = body && typeof body === "object" ? (body as { user?: unknown }) : {};
      const user = publicUserFromUnknown(payload.user);
      if (user && user.role !== "admin") {
        await requestJSON("/api/v1/auth/logout", { method: "POST" });
        setError("需要管理员账号才能进入管理后台");
        return;
      }
      router.replace("/overview");
      router.refresh();
    } finally {
      setBusy(false);
      setPassword("");
    }
  }

  return (
    <main className="shell">
      <p className="eyebrow">CONTROL API</p>
      <h1>管理员登录</h1>
      <form className="card" onSubmit={onSubmit} autoComplete="off">
        <label>
          用户名
          <input value={username} onChange={(event) => setUsername(event.target.value)} name="username" required />
        </label>
        <label>
          密码
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            name="password"
            type="password"
            required
          />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <button type="submit" disabled={busy}>
          {busy ? "登录中…" : "登录"}
        </button>
        <p className="muted">没有公开注册。初始管理员只能通过服务器 CLI 创建。</p>
      </form>
    </main>
  );
}
