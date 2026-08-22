"use client";

import { useEffect } from "react";
import {
  formatPrerequisiteInstallError,
  getManagedObsDesktopBridge
} from "../obs/managed-obs-state";

export type VirtualAudioSetupState = "idle" | "installing" | "installed" | "reboot-pending" | "failed";

export type VirtualAudioSetupStatus = {
  state: VirtualAudioSetupState;
  text: string;
};

const SETUP_EVENT = "ai-virtual-audio-setup";
const REBOOT_NOTICED_KEY = "ai-virtual-audio-reboot-noticed";
/** 重启提示最长保留 7 天，设备出现或到期后自动清除。 */
const REBOOT_NOTICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let latestStatus: VirtualAudioSetupStatus = { state: "idle", text: "" };
let setupStarted = false;

export function subscribeVirtualAudioSetup(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(SETUP_EVENT, listener);
  return () => window.removeEventListener(SETUP_EVENT, listener);
}

export function getVirtualAudioSetupStatus(): VirtualAudioSetupStatus {
  return latestStatus;
}

function publishStatus(next: VirtualAudioSetupStatus) {
  if (latestStatus.text === next.text && latestStatus.state === next.state) return;
  latestStatus = next;
  window.dispatchEvent(new CustomEvent(SETUP_EVENT));
}

function readRebootNotice(): number | null {
  try {
    const raw = window.localStorage.getItem(REBOOT_NOTICED_KEY);
    const at = raw ? Number(raw) : Number.NaN;
    if (!Number.isFinite(at) || at <= 0) return null;
    if (Date.now() - at > REBOOT_NOTICE_MAX_AGE_MS) {
      window.localStorage.removeItem(REBOOT_NOTICED_KEY);
      return null;
    }
    return at;
  } catch {
    return null;
  }
}

function writeRebootNotice() {
  try {
    window.localStorage.setItem(REBOOT_NOTICED_KEY, String(Date.now()));
  } catch {
    // ignore quota / private mode
  }
}

function clearRebootNotice() {
  try {
    window.localStorage.removeItem(REBOOT_NOTICED_KEY);
  } catch {
    // ignore quota / private mode
  }
}

/**
 * 全局挂载：启动时自动检测并安装 VB-CABLE（仅 Electron 客户端内生效，无可见 UI）。
 * 每会话只执行一次；失败或用户拒绝 UAC 后本会话不再重试，只发布 failed 状态。
 * 线路的静默实测与续验仍由设置页 AudioRouteControl 负责。
 */
export function VirtualAudioAutoSetup() {
  useEffect(() => {
    if (setupStarted) return;
    const bridge = getManagedObsDesktopBridge();
    if (!bridge) return;
    setupStarted = true;
    let disposed = false;

    void (async () => {
      try {
        const status = await bridge.getPrerequisiteStatus();
        if (disposed) return;
        if (status.virtualAudioInstalled) {
          clearRebootNotice();
          publishStatus({ state: "installed", text: "虚拟声卡已安装，线路将自动实测。" });
          return;
        }
        if (readRebootNotice() !== null) {
          publishStatus({ state: "reboot-pending", text: "虚拟声卡已安装，重启电脑后设备会自动出现并继续检测。" });
          return;
        }
        publishStatus({ state: "installing", text: "正在自动准备虚拟声卡（VB-CABLE）…" });
        if (!status.virtualAudioDriverStaged && !status.virtualAudioPresentInDriverStore) {
          const ensured = await bridge.ensureVirtualAudio();
          if (disposed) return;
          if (!ensured.staged) {
            publishStatus({ state: "failed", text: `虚拟声卡自动安装失败：${formatPrerequisiteInstallError(ensured.error)}` });
            return;
          }
        }
        // 安装需要一次管理员授权（UAC），这是 Windows 驱动安装的硬性要求。
        publishStatus({ state: "installing", text: "正在自动安装虚拟声卡，Windows 将请求一次管理员授权…" });
        const result = await bridge.installPrerequisite("virtual-audio");
        if (disposed) return;
        if (!result.installed) {
          publishStatus({ state: "failed", text: `虚拟声卡自动安装失败：${formatPrerequisiteInstallError(result.error)}` });
          return;
        }
        if (result.rebootRequired) {
          writeRebootNotice();
          publishStatus({ state: "reboot-pending", text: "虚拟声卡已安装，重启电脑后设备会自动出现并继续检测。" });
          return;
        }
        clearRebootNotice();
        publishStatus({ state: "installed", text: "虚拟声卡已安装，线路将自动实测。" });
      } catch {
        if (!disposed) {
          publishStatus({ state: "failed", text: "虚拟声卡自动安装未完成，可到设置页手动重试。" });
        }
      }
    })();

    return () => {
      disposed = true;
    };
  }, []);

  return null;
}
