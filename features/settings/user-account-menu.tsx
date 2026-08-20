"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { logoutControlSession, readControlSession } from "../auth/control-session";

export type AccountPage = "workspace" | "settings" | "records" | "login";

export function UserAccountMenu({
  current,
  onOpenUpload
}: {
  current: AccountPage;
  onOpenUpload?: () => void;
}) {
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
        <span className="accountCaret" aria-hidden>▼</span>
      </button>
      {open ? (
        <div className="accountMenu" role="menu" aria-label="账户菜单">
          <div className="accountMenuSection">
            <Link
              role="menuitem"
              className={current === "workspace" ? "active" : ""}
              href="/"
              onClick={() => setOpen(false)}
            >
              工作台
            </Link>
            <a role="menuitem" href="/stage" target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>
              舞台
            </a>
            {onOpenUpload ? (
              <button
                type="button"
                role="menuitem"
                className="accountMenuUpload"
                onClick={() => {
                  setOpen(false);
                  onOpenUpload();
                }}
              >
                上传资料
              </button>
            ) : null}
            <Link
              role="menuitem"
              className={current === "records" ? "active" : ""}
              href="/records"
              onClick={() => setOpen(false)}
            >
              记录
            </Link>
            <Link
              role="menuitem"
              className={current === "settings" ? "active" : ""}
              href="/settings"
              onClick={() => setOpen(false)}
            >
              设置<span className="menuKbd">Ctrl+,</span>
            </Link>
          </div>
          <div className="accountMenuDivider" />
          <button type="button" role="menuitem" className="accountMenuLogout" onClick={() => void logout()}>
            退出登录
          </button>
          <div className="accountMenuDivider" />
          <div className="accountMenuFooter">
            <div>
              <strong>{username}</strong>
              <span>Pro Plan</span>
            </div>
            <Link className="accountGear" href="/settings" aria-label="设置" onClick={() => setOpen(false)}>
              ⚙
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
