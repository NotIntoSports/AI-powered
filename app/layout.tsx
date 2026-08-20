import type { ReactNode } from "react";
import "./styles.css";
import { AutoBridgeController } from "../features/rtc/auto-bridge-controller";
import { VirtualAudioAutoSetup } from "../features/audio/virtual-audio-auto-setup";

export const metadata = {
  title: "AI虚拟助手",
  description: "本地 AI虚拟助手：可用于面试、会议主持与虚拟直播互动"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <AutoBridgeController />
        <VirtualAudioAutoSetup />
        {children}
      </body>
    </html>
  );
}
