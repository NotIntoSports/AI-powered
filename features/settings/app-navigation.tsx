import Link from "next/link";

type AppNavigationProps = {
  current: "workspace" | "settings" | "records";
};

export function AppNavigation({ current }: AppNavigationProps) {
  return (
    <nav className="appNav" aria-label="主导航">
      <Link className={current === "workspace" ? "active" : ""} href="/">面试工作台</Link>
      <Link className={current === "settings" ? "active" : ""} href="/settings">设置</Link>
      <Link className={current === "records" ? "active" : ""} href="/records">面试记录</Link>
      <a href="/stage" target="_blank" rel="noreferrer">数字人舞台 ↗</a>
    </nav>
  );
}
