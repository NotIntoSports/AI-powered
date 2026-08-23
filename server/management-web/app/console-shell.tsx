"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { requestJSON, type PublicUser } from "../lib/control-api";

const links = [
  { href: "/overview", label: "概览" },
  { href: "/users", label: "账户" },
  { href: "/sessions", label: "当前线路" },
  { href: "/settings/ai", label: "AI 配置" },
  { href: "/settings/rtc", label: "RTC 配置" },
  { href: "/settings/speech", label: "语音" },
  { href: "/settings/storage", label: "对象存储" },
  { href: "/settings/roles", label: "角色话术" },
  { href: "/resumes", label: "资料" }
];

export function ConsoleShell({
  me,
  children
}: {
  me: PublicUser | null;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await requestJSON("/api/v1/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <main className="shell">
      <div className="topbar">
        <div>
          <p className="eyebrow">CONTROL API</p>
          <h1>管理后台</h1>
        </div>
        <div>
          <p className="muted">{me ? `${me.username} · ${me.role}` : ""}</p>
          <button className="secondary" type="button" onClick={() => void logout()}>
            退出
          </button>
        </div>
      </div>
      <nav className="nav">
        {links.map((link) => {
          const active = pathname === link.href;
          return (
            <Link key={link.href} className={active ? "active" : ""} href={link.href}>
              {link.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </main>
  );
}

export function formatTime(value?: string) {
  if (!value) {
    return "—";
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }
  return new Date(parsed).toLocaleString("zh-CN", { hour12: false });
}

export function OnlineMark({ online }: { online: boolean }) {
  return <span className={online ? "online" : "offline"}>{online ? "在线" : "离线"}</span>;
}
