"use client";

import { useEffect, useState } from "react";
import {
  AUTO_BRIDGE_POLL_MS,
  decideAutoBridge,
  initialAutoBridgeMachine,
  recordAttempt,
  recordCaptured,
  recordFailure,
  type AutoBridgeMachine
} from "./auto-bridge-decision.ts";
import {
  getDesktopBridge,
  isBridgeSessionRunning,
  getBridgeSessionHandle,
  providerLabel,
  startBridgeSession,
  stopBridgeSession
} from "./bridge-session.ts";
import {
  loadAutoBridgeEnabled,
  loadAutoBridgeSoftware,
  subscribeAutoBridgeStore,
  MEETING_SOFTWARE_LABELS
} from "./auto-bridge-store.ts";

export type AutoBridgeStatus = {
  text: string;
  state: "off" | "waiting" | "captured" | "backoff" | "needs-manual" | "starting";
  sessionKey?: string;
};

const STATUS_EVENT = "ai-auto-bridge-status";

export function subscribeAutoBridgeStatus(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(STATUS_EVENT, listener);
  return () => window.removeEventListener(STATUS_EVENT, listener);
}

let latestStatus: AutoBridgeStatus = { text: "已关闭", state: "off" };
export function getAutoBridgeStatus(): AutoBridgeStatus {
  return latestStatus;
}
function publishStatus(next: AutoBridgeStatus) {
  if (latestStatus.text === next.text && latestStatus.state === next.state) return;
  latestStatus = next;
  window.dispatchEvent(new CustomEvent(STATUS_EVENT));
}

/** 全局挂载：仅 Electron 客户端内生效，无可见 UI。 */
export function AutoBridgeController() {
  const [, forceRender] = useState(0);

  useEffect(() => {
    let machine: AutoBridgeMachine = initialAutoBridgeMachine();
    let busy = false;
    let disposed = false;
    let pendingRetick = false;

    async function tick() {
      if (disposed) return;
      if (busy) {
        pendingRetick = true;
        return;
      }
      busy = true;
      try {
        const enabled = loadAutoBridgeEnabled();
        const software = loadAutoBridgeSoftware();
        if (!enabled || !software) {
          machine = initialAutoBridgeMachine();
          if (isBridgeSessionRunning() && getBridgeSessionHandle()?.owner === "auto") await stopBridgeSession();
          publishStatus({ text: "已关闭", state: "off" });
          return;
        }
        const bridge = getDesktopBridge();
        const processes = bridge ? await bridge.listMeetingProcesses() : [];
        if (disposed) return;
        const manualRunning = isBridgeSessionRunning() && getBridgeSessionHandle()?.owner === "manual";
        const decision = decideAutoBridge(processes, {
          now: Date.now(),
          machine,
          enabled,
          software,
          sessionRunning: isBridgeSessionRunning()
        });
        machine = decision.machine;
        const action = decision.action;
        if (action === "idle") { publishStatus({ text: "已关闭", state: "off" }); return; }
        if (action === "waiting") { publishStatus({ text: `等待中（每5秒检测 ${MEETING_SOFTWARE_LABELS[software] || software}）`, state: "waiting" }); return; }
        if (action === "holding") {
          if (manualRunning) return; // 手动会话自己维护状态文案
          const handle = getBridgeSessionHandle();
          publishStatus(handle
            ? { text: `已自动捕获 · 房间 ${handle.roomId}（${providerLabel(handle.provider)}）`, state: "captured", sessionKey: handle.roomId }
            : { text: "等待中（每5秒检测）", state: "waiting" });
          return;
        }
        if (action === "backoff") { publishStatus({ text: "重试等待中…", state: "backoff" }); return; }
        if (action === "needs-manual") { publishStatus({ text: "需人工处理：自动推流连续失败，请到「会议音频桥接」手动启动", state: "needs-manual" }); return; }
        if (action === "stop") {
          if (isBridgeSessionRunning() && getBridgeSessionHandle()?.owner === "auto") await stopBridgeSession();
          publishStatus({ text: "等待中（每5秒检测）", state: "waiting" });
          return;
        }
        // action = { type: "start", pid }
        publishStatus({ text: "检测到会议，正在自动建立推流…", state: "starting" });
        machine = recordAttempt(machine, Date.now(), action.pid);
        try {
          const handle = await startBridgeSession(action.pid, "auto", "meet", {
            onStatus: (message) => publishStatus({ text: message, state: "captured" }),
            onLevel: () => undefined,
            onProcessExited: () => {
              if (getBridgeSessionHandle()?.owner === "auto") void stopBridgeSession();
            }
          });
          machine = recordCaptured(machine, action.pid);
          publishStatus({
            text: `已自动捕获 · 房间 ${handle.roomId}（${providerLabel(handle.provider)}）`,
            state: "captured",
            sessionKey: handle.roomId
          });
        } catch (cause) {
          console.error(`[auto-bridge] start failed pid=${action.pid}: ${cause instanceof Error ? cause.message : String(cause)}`, cause);
          machine = recordFailure(machine, Date.now());
          publishStatus({ text: `自动推流失败：${cause instanceof Error ? cause.message : "未知错误"}`, state: "backoff" });
        }
      } finally {
        busy = false;
        if (pendingRetick) {
          pendingRetick = false;
          void tick();
        }
      }
    }

    // 开关变化时立即触发一轮 tick，保证关闭开关即刻停止自动会话（规格行为 8）
    const stopStoreSync = subscribeAutoBridgeStore(() => {
      forceRender((value) => value + 1);
      void tick();
    });
    void tick();
    const timer = window.setInterval(() => void tick(), AUTO_BRIDGE_POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      stopStoreSync();
      if (isBridgeSessionRunning() && getBridgeSessionHandle()?.owner === "auto") void stopBridgeSession();
    };
  }, []);

  return null;
}
