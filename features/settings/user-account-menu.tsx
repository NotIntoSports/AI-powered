"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { logoutControlSession, readControlSession } from "../auth/control-session";

export type AccountPage = "workspace" | "settings" | "records" | "login";

export function UserAccountMenu({ current }: { current: AccountPage }) {
  const [username, setUsername] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    void readControlSession()
      .then((session) => {
        if (!active) return;
        setUsername(session.connected ? session.user?.username || "已登录" : null);
      })
      .catch(() => {
        if (active) setUsername(null);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function logout() {
    await logoutControlSession();
    setUsername(null);
    setOpen(false);
    window.location.reload();
  }

  if (!username) {
    return (
      <div className="accountDock" ref={rootRef}>
        <Link className={`accountDockTrigger ${current === "login" ? "active" : ""}`} href="/login">
          登录
        </Link>
      </div>
    );
  }

  const initial = username.trim().slice(0, 1).toUpperCase() || "用";

  return (
    <div className="accountDock" ref={rootRef}>
      <button
        type="button"
        className={`accountDockTrigger ${open ? "open" : ""}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="accountAvatar" aria-hidden>
          {initial}
        </span>
        <span className="accountDockLabel">{username}</span>
      </button>
      {open ? (
        <div className="accountMenu" role="menu" aria-label="账户菜单">
          <div className="accountMenuSection">
            <Link
              role="menuitem"
              className={current === "settings" ? "active" : ""}
              href="/settings"
              onClick={() => setOpen(false)}
            >
              设置
            </Link>
            <Link
              role="menuitem"
              className={current === "records" ? "active" : ""}
              href="/records"
              onClick={() => setOpen(false)}
            >
              对话记录
            </Link>
            <Link role="menuitem" href="/settings?focus=virtual" onClick={() => setOpen(false)}>
              会议接入（虚拟声卡）
            </Link>
            <a role="menuitem" href="/stage" target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>
              助手舞台 ↗
            </a>
          </div>
          <div className="accountMenuDivider" />
          <button type="button" role="menuitem" className="accountMenuLogout" onClick={() => void logout()}>
            退出
          </button>
          <div className="accountMenuFooter">
            <span className="accountAvatar" aria-hidden>
              {initial}
            </span>
            <div>
              <strong>{username}</strong>
              <span>客户端账号</span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
