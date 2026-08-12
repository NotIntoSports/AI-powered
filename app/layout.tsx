import type { ReactNode } from "react";
import "./styles.css";

export const metadata = {
  title: "AI 数字人",
  description: "本地 AI 数字人互动与演示工具"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
