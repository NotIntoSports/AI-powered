"use client";

import { useEffect, useState } from "react";
import {
  AUTO_BRIDGE_POLL_MS,
  decideAutoBridge,
  initialAutoBridgeMachine,
  recordAttempt,
  recordCaptured,
  recordCapturedExit,
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
import { emitPipelineEvent } from "../diagnostics/pipeline-log.ts";

export type AutoBridgeStatus = {
  text: string;
  state: "off" | "waiting" | "captured" | "backoff" | "needs-manual" | "starting" | "agent-missing";
  sessionKey?: string;
};

const STATUS_EVENT = "ai-auto-bridge-status";
const RESTART_EVENT = "ai-auto-bridge-restart";
const AGENT_WAIT_MS = 8_000;

export function requestAutoBridgeRestart() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(RESTART_EVENT));
}

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
    let recoverySource: "process-exited" | "transport-disconnected" | null = null;
    let lastFailureText = "";
    let agentPresent = false;
    let agentWaitTimer: ReturnType<typeof setTimeout> | null = null;

    function clearAgentWait() {
      if (agentWaitTimer) {
        clearTimeout(agentWaitTimer);
        agentWaitTimer = null;
      }
    }

    function watchAgentForRoom(roomId: string) {
      clearAgentWait();
      if (agentPresent) {
        publishStatus({
          text: `已自动捕获 · 房间 ${roomId}（${providerLabel("livekit")}）`,
          state: "captured",
          sessionKey: roomId
        });
        return;
      }
      agentWaitTimer = setTimeout(() => {
        agentWaitTimer = null;
        if (agentPresent || getBridgeSessionHandle()?.roomId !== roomId) return;
        publishStatus({
          text: `房间已连接，但语音 Agent 未接入，请点「重新桥接」· ${roomId}`,
          state: "agent-missing",
          sessionKey: roomId
        });
      }, AGENT_WAIT_MS);
    }

    async function recoverCapturedBridge(
      pid: number,
      source: "process-exited" | "transport-disconnected",
      reason: string = source
    ) {
      if (disposed || machine.capturedPid !== pid) return;
      const previous = getBridgeSessionHandle();
      clearAgentWait();
      agentPresent = false;
      machine = recordCapturedExit(machine, pid);
      recoverySource = source;
      publishStatus({ text: "桥接已中断，正在重新检测…", state: "starting" });
      console.warn(`[auto-bridge] recovery source=${source} pid=${pid} roomId=${previous?.roomId || "unknown"} reason=${reason}`);
      void emitPipelineEvent({
        event: "bridge.recovery-started",
        traceId: previous?.roomId,
        fields: { source, reason, pid, status: "reconnecting" }
      });
      await stopBridgeSession();
      if (!disposed) await tick();
    }

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
          clearAgentWait();
          agentPresent = false;
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
        if (action === "waiting") {
          recoverySource = null;
          lastFailureText = "";
          publishStatus({ text: `等待中（每5秒检测 ${MEETING_SOFTWARE_LABELS[software] || software}）`, state: "waiting" });
          return;
        }
        if (action === "holding") {
          if (manualRunning) return; // 手动会话自己维护状态文案
          const handle = getBridgeSessionHandle();
          if (latestStatus.state === "agent-missing" && latestStatus.sessionKey === handle?.roomId) return;
          publishStatus(handle
            ? { text: `已自动捕获 · 房间 ${handle.roomId}（${providerLabel(handle.provider)}）`, state: "captured", sessionKey: handle.roomId }
            : { text: "等待中（每5秒检测）", state: "waiting" });
          return;
        }
        if (action === "backoff") {
          publishStatus({
            text: lastFailureText ? `${lastFailureText} · 10秒后重试` : "重试等待中…",
            state: "backoff"
          });
          return;
        }
        if (action === "needs-manual") { publishStatus({ text: "需人工处理：自动推流连续失败，请到「会议音频桥接」手动启动", state: "needs-manual" }); return; }
        if (action === "stop") {
          if (isBridgeSessionRunning() && getBridgeSessionHandle()?.owner === "auto") await stopBridgeSession();
          publishStatus({ text: "等待中（每5秒检测）", state: "waiting" });
          return;
        }
        // action = { type: "start", pid }
        publishStatus({ text: "检测到会议，正在自动建立推流…", state: "starting" });
        machine = recordAttempt(machine, Date.now(), action.pid);
        agentPresent = false;
        clearAgentWait();
        try {
          const handle = await startBridgeSession(action.pid, "auto", "meet", {
            onStatus: (message) => publishStatus({ text: message, state: "captured" }),
            onLevel: () => undefined,
            onProcessExited: () => {
              void recoverCapturedBridge(action.pid, "process-exited");
            },
            onTransportState: (state, reason) => {
              if (machine.capturedPid !== action.pid) return;
              if (state === "reconnecting") {
                publishStatus({ text: "网络连接波动，正在重连…", state: "starting" });
                console.warn(`[auto-bridge] transport state=reconnecting pid=${action.pid} roomId=${getBridgeSessionHandle()?.roomId || "unknown"}`);
                return;
              }
              if (state === "connected") {
                const current = getBridgeSessionHandle();
                if (current) {
                  publishStatus({
                    text: `已自动捕获 · 房间 ${current.roomId}（${providerLabel(current.provider)}）`,
                    state: "captured",
                    sessionKey: current.roomId
                  });
                  console.log(`[auto-bridge] transport state=connected pid=${action.pid} roomId=${current.roomId}`);
                }
                return;
              }
              if (state === "disconnected") {
                void recoverCapturedBridge(action.pid, "transport-disconnected", reason || "unknown");
              }
            },
            onAgentPresence: (present) => {
              agentPresent = present;
              const current = getBridgeSessionHandle();
              if (!current || current.owner !== "auto") return;
              if (present) {
                clearAgentWait();
                publishStatus({
                  text: `已自动捕获 · 房间 ${current.roomId}（${providerLabel(current.provider)}）`,
                  state: "captured",
                  sessionKey: current.roomId
                });
                return;
              }
              if (latestStatus.state === "captured" || latestStatus.state === "agent-missing") {
                publishStatus({
                  text: `房间已连接，但语音 Agent 未接入，请点「重新桥接」· ${current.roomId}`,
                  state: "agent-missing",
                  sessionKey: current.roomId
                });
              }
            }
          });
          machine = recordCaptured(machine, action.pid);
          watchAgentForRoom(handle.roomId);
          publishStatus({
            text: `已自动捕获 · 房间 ${handle.roomId}（${providerLabel(handle.provider)}）`,
            state: "captured",
            sessionKey: handle.roomId
          });
          if (recoverySource) {
            console.log(`[auto-bridge] recovered source=${recoverySource} pid=${action.pid} roomId=${handle.roomId}`);
            void emitPipelineEvent({
              event: "bridge.recovered",
              traceId: handle.roomId,
              fields: { source: recoverySource, pid: action.pid, provider: handle.provider, status: "ready" }
            });
            recoverySource = null;
          }
        } catch (cause) {
          console.error(`[auto-bridge] start failed pid=${action.pid}: ${cause instanceof Error ? cause.message : String(cause)}`, cause);
          lastFailureText = `自动推流失败：${cause instanceof Error ? cause.message : "未知错误"}`;
          machine = recordFailure(machine, Date.now());
          publishStatus({ text: lastFailureText, state: "backoff" });
        }
      } finally {
        busy = false;
        if (pendingRetick) {
          pendingRetick = false;
          void tick();
        }
      }
    }

    async function restartAutoSession() {
      if (disposed) return;
      clearAgentWait();
      agentPresent = false;
      publishStatus({ text: "正在重新建立房间…", state: "starting" });
      machine = initialAutoBridgeMachine();
      if (isBridgeSessionRunning() && getBridgeSessionHandle()?.owner === "auto") await stopBridgeSession();
      if (!disposed) await tick();
    }

    // 开关变化时立即触发一轮 tick，保证关闭开关即刻停止自动会话（规格行为 8）
    const stopStoreSync = subscribeAutoBridgeStore(() => {
      forceRender((value) => value + 1);
      void tick();
    });
    const onRestart = () => { void restartAutoSession(); };
    window.addEventListener(RESTART_EVENT, onRestart);
    void tick();
    const timer = window.setInterval(() => void tick(), AUTO_BRIDGE_POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      clearAgentWait();
      window.removeEventListener(RESTART_EVENT, onRestart);
      stopStoreSync();
      if (isBridgeSessionRunning() && getBridgeSessionHandle()?.owner === "auto") void stopBridgeSession();
    };
  }, []);

  return null;
}
