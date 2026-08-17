"use client";

import Link from "next/link";

/** Minimal in-header home link; account/settings live in the bottom-left account menu. */
export function AppNavigation({ current }: { current: "workspace" | "settings" | "records" | "login" }) {
  if (current === "workspace") {
    return null;
  }
  return (
    <nav className="appNav appNavMinimal" aria-label="页面导航">
      <Link href="/">虚拟助手工作台</Link>
    </nav>
  );
}
