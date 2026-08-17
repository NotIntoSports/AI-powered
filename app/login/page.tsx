"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { loginControlSession, readControlSession } from "../../features/auth/control-session";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let active = true;
    void readControlSession()
      .then((session) => {
        if (!active) return;
        if (session.connected) {
          router.replace("/");
          return;
        }
        setChecking(false);
      })
      .catch(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [router]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = await loginControlSession(username, password);
      if (!result.ok) {
        setError(result.message || "登录失败");
        return;
      }
      router.replace("/");
      router.refresh();
    } finally {
      setBusy(false);
      setPassword("");
    }
  }

  if (checking) {
    return (
      <main className="loginPage">
        <p className="muted">正在检查登录状态…</p>
      </main>
    );
  }

  return (
    <main className="loginPage">
      <section className="loginCard card">
        <p className="eyebrow">管理端</p>
        <h1>客户端登录</h1>
        <p className="muted">用户名就是登录账号。请填写管理后台「现有用户」表里的用户名，例如 admin，以及创建这个用户时设置的密码。网页后台的 owner 密码不能用在这里；忘记了请到该行点「重置密码」。</p>
        <form onSubmit={onSubmit} autoComplete="off">
          <label>
            用户名
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              name="username"
              autoComplete="username"
              required
            />
          </label>
          <label>
            密码
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          {error ? <p className="error" role="alert">{error}</p> : null}
          <button type="submit" disabled={busy}>
            {busy ? "登录中…" : "连接管理端"}
          </button>
        </form>
        <a className="textLink" href="/">返回虚拟助手工作台</a>
      </section>
    </main>
  );
}
