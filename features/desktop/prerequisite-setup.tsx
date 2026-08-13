"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  formatPrerequisiteInstallError,
  getManagedObsDesktopBridge,
  type PrerequisiteStatus
} from "../obs/managed-obs-state";

type InstallComponent = "obs" | "virtual-audio";

function environmentMessage(status: PrerequisiteStatus) {
  if (!status.obsBundled) return "客户端中的专用 OBS 资源缺失，请重新安装客户端。";
  if (!status.virtualCameraRegistered) return "专用 OBS 已内置；还需管理员授权注册 OBS 虚拟摄像头。";
  if (!status.virtualAudioInstalled) {
    return status.virtualAudioDriverStaged
      ? "OBS 已就绪；虚拟音频驱动已内置，等待管理员授权安装。"
      : "OBS 已就绪；安装包中的虚拟音频驱动资源缺失。";
  }
  return "专用 OBS、OBS 虚拟摄像头与虚拟音频设备均已就绪。";
}

export function PrerequisiteSetup() {
  const mountedRef = useRef(false);
  const refreshIdRef = useRef(0);
  const [status, setStatus] = useState<PrerequisiteStatus | null>(null);
  const [message, setMessage] = useState("正在检测 Windows 音视频环境…");
  const [working, setWorking] = useState<InstallComponent | "refresh" | null>("refresh");

  const refresh = useCallback(async () => {
    const bridge = getManagedObsDesktopBridge();
    const refreshId = ++refreshIdRef.current;
    setWorking("refresh");
    setMessage("正在重新检测 Windows 音视频环境…");
    if (!bridge) {
      if (mountedRef.current && refreshId === refreshIdRef.current) {
        setWorking(null);
        setMessage("浏览器模式不会安装系统组件，请使用 Windows 桌面客户端。");
      }
      return;
    }
    try {
      const next = await bridge.getPrerequisiteStatus();
      if (!mountedRef.current || refreshId !== refreshIdRef.current) return;
      setStatus(next);
      setMessage(environmentMessage(next));
    } catch {
      if (mountedRef.current && refreshId === refreshIdRef.current) {
        setMessage("Windows 音视频环境检测未完成，请重新检测。");
      }
    } finally {
      if (mountedRef.current && refreshId === refreshIdRef.current) setWorking(null);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
      refreshIdRef.current += 1;
    };
  }, [refresh]);

  async function install(component: InstallComponent) {
    const bridge = getManagedObsDesktopBridge();
    if (!bridge || working) return;
    refreshIdRef.current += 1;
    setWorking(component);
    setMessage(
      component === "obs"
        ? "正在验证 OBS 官方组件，Windows 随后会请求管理员授权注册虚拟摄像头…"
        : "正在验证并安装签名虚拟音频驱动，Windows 将请求管理员授权…"
    );
    try {
      const result = await bridge.installPrerequisite(component);
      if (!result.installed) {
        setMessage(formatPrerequisiteInstallError(result.error));
        return;
      }
      if (result.rebootRequired) {
        setMessage("虚拟音频驱动已加入 Windows，重启电脑后再点击“重新检测”。");
        return;
      }
      const next = await bridge.getPrerequisiteStatus();
      if (!mountedRef.current) return;
      setStatus(next);
      setMessage(environmentMessage(next));
    } catch {
      if (mountedRef.current) setMessage("系统组件处理未完成，请重试。");
    } finally {
      if (mountedRef.current) setWorking(null);
    }
  }

  const ready = Boolean(status?.obsBundled && status.virtualCameraRegistered && status.virtualAudioInstalled);
  const busy = working !== null;

  return (
    <article className="card">
      <div className="cardHeading">
        <h2>客户端安装环境</h2>
        <span className={ready ? "ready" : ""} aria-live="polite">
          {working === "refresh" ? "检测中" : ready ? "已就绪" : "待处理"}
        </span>
      </div>
      <div className="checks">
        <p>专用 OBS 资源：{status?.obsBundled ? "已内置" : status ? "缺失" : "检测中"}</p>
        <p>OBS Virtual Camera：{status?.virtualCameraRegistered ? "已注册" : status ? "待授权注册" : "检测中"}</p>
        <p>虚拟音频设备：{status?.virtualAudioInstalled ? "已安装" : status ? "未安装" : "检测中"}</p>
      </div>
      <div className="obsActions">
        <button
          disabled={busy || !status?.obsBundled || status.virtualCameraRegistered}
          onClick={() => void install("obs")}
        >
          {working === "obs" ? "正在等待授权…" : "授权注册 OBS 虚拟摄像头"}
        </button>
        <button
          disabled={busy || status?.virtualAudioInstalled || !status?.virtualAudioDriverStaged}
          onClick={() => void install("virtual-audio")}
        >
          {working === "virtual-audio" ? "正在等待授权…" : "安装虚拟音频"}
        </button>
        <button className="ghost" disabled={busy} onClick={() => void refresh()}>
          {working === "refresh" ? "正在检测…" : "重新检测"}
        </button>
      </div>
      <p aria-live="polite">{message}</p>
      <p className="muted">只使用固定版本、哈希匹配且带官方签名的组件；不会创建防火墙例外或启用 Windows 测试签名模式。</p>
    </article>
  );
}
