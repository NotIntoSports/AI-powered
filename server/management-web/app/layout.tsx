import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "管理后台",
  description: "AI 面试官控制 API 管理控制台"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
