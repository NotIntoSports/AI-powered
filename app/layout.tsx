import type { ReactNode } from "react";
import "./styles.css";

export const metadata = {
  title: "AI 面试官控制台",
  description: "用于已告知候选人的 AI 辅助线上面试"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
