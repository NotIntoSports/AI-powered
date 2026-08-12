import Link from "next/link";

export function AppNavigation({ current }: { current: "workspace" | "settings" | "records" }) {
  return <nav className="appNav" aria-label="主导航">
    <Link className={current === "workspace" ? "active" : ""} href="/">数字人工作台</Link>
    <Link className={current === "settings" ? "active" : ""} href="/settings">设置</Link>
    <Link className={current === "records" ? "active" : ""} href="/records">对话记录</Link>
    <a href="/stage" target="_blank" rel="noreferrer">数字人舞台 ↗</a>
  </nav>;
}
