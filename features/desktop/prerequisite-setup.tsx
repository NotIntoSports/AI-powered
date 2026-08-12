"use client";

import { useEffect, useState } from "react";

type Status = { obsInstalled: boolean; virtualAudioInstalled: boolean; virtualAudioDriverStaged: boolean };
type InstallErrorCode = "uac-cancelled" | "resource-missing" | "signature-rejected" | "install-failed" | "unknown";
type InstallResult =
  | { installed: true; rebootRequired: boolean }
  | { installed: false; error: { code: InstallErrorCode; message: string } };
type SetupBridge = {
  getPrerequisiteStatus(): Promise<Status>;
  installPrerequisite(component: "obs" | "virtual-audio"): Promise<InstallResult>;
};

const installErrorMessages: Record<InstallErrorCode, string> = {
  "uac-cancelled": "管理员授权已取消。请重新安装并在 Windows 提示中选择“是”。",
  "resource-missing": "安装包中的虚拟音频文件缺失，请重新下载安装客户端。",
  "signature-rejected": "Windows 拒绝了驱动签名。请检查系统安全策略，或联系 IT 管理员。",
  "install-failed": "Windows 驱动安装失败。",
  unknown: "安装进程异常退出。"
};

export function PrerequisiteSetup() {
  const [status, setStatus] = useState<Status | null>(null);
  const [message, setMessage] = useState("正在检测 Windows 音视频环境…");
  const [working, setWorking] = useState(false);
  async function refresh() {
    const bridge = (window as typeof window & { aiInterviewerDesktop?: SetupBridge }).aiInterviewerDesktop;
    if (!bridge) { setMessage("浏览器模式不会安装系统组件，请使用桌面客户端。"); return; }
    const next = await bridge.getPrerequisiteStatus();
    setStatus(next);
    setMessage(next.obsInstalled && next.virtualAudioInstalled ? "OBS 与虚拟音频设备均已就绪。" : "请安装缺少的组件；Windows 会显示管理员授权窗口。");
  }
  useEffect(() => { void refresh(); }, []);
  async function install(component: "obs" | "virtual-audio") {
    const bridge = (window as typeof window & { aiInterviewerDesktop?: SetupBridge }).aiInterviewerDesktop;
    if (!bridge) return;
    setWorking(true);
    setMessage(component === "obs" ? "正在安装官方 OBS…" : "正在安装签名虚拟音频驱动…");
    try {
      const result = await bridge.installPrerequisite(component);
      if (!result.installed) {
        setMessage(`${installErrorMessages[result.error.code]} ${result.error.message}`);
        return;
      }
      if (result.rebootRequired) {
        setMessage("虚拟音频驱动已加入 Windows，重启电脑后再点击“重新检测”。");
        return;
      }
      await refresh();
    }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : "安装失败"); }
    finally { setWorking(false); }
  }
  return (
    <article className="card">
      <div className="cardHeading"><h2>客户端安装环境</h2><span className={status?.obsInstalled && status.virtualAudioInstalled ? "ready" : ""}>{status?.obsInstalled && status.virtualAudioInstalled ? "已就绪" : "待检查"}</span></div>
      <div className="checks">
        <p>OBS Studio：{status?.obsInstalled ? "已安装" : "未安装"}</p>
        <p>虚拟音频设备：{status?.virtualAudioInstalled ? "已安装" : "未安装"}</p>
      </div>
      <div className="obsActions">
        <button disabled={working || status?.obsInstalled} onClick={() => void install("obs")}>安装 OBS</button>
        <button disabled={working || status?.virtualAudioInstalled} onClick={() => void install("virtual-audio")}>安装虚拟音频</button>
        <button className="ghost" disabled={working} onClick={() => void refresh()}>重新检测</button>
      </div>
      <p>{message}</p>
      <p className="muted">只使用固定版本、哈希匹配且已签名的组件；不会启用 Windows 测试签名模式。</p>
    </article>
  );
}
