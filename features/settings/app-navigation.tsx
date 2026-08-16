"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { logoutControlSession, readControlSession } from "../auth/control-session";

export function AppNavigation({ current }: { current: "workspace" | "settings" | "records" | "login" }) {
  const [username, setUsername] = useState<string | null>(null);

  useEffect(() => {
    void readControlSession().then((session) => {
      setUsername(session.connected ? (session.user?.username || "已登录") : null);
    });
  }, []);

  async function logout() {
    await logoutControlSession();
    setUsername(null);
    window.location.reload();
  }

  return (
    <nav className="appNav" aria-label="主导航">
      <Link className={current === "workspace" ? "active" : ""} href="/">数字人工作台</Link>
      <Link className={current === "settings" ? "active" : ""} href="/settings">设置</Link>
      <Link className={current === "records" ? "active" : ""} href="/records">对话记录</Link>
      <a href="/stage" target="_blank" rel="noreferrer">数字人舞台 ↗</a>
      {username ? (
        <>
          <span className="navUser">{username}</span>
          <button type="button" className="navAction" onClick={() => void logout()}>退出</button>
        </>
      ) : (
        <Link className={current === "login" ? "active" : ""} href="/login">登录</Link>
      )}
    </nav>
  );
}
