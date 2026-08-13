"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  failureNeedsAuthorization,
  formatManagedObsFailure,
  formatPrerequisiteInstallError,
  formatUnexpectedObsError,
  getManagedObsDesktopBridge,
  managedObsBadgeLabel,
  type InterventionAction,
  type ManagedObsBadge,
  type ManagedObsState,
  type PrerequisiteStatus
} from "./managed-obs-state";

type ObsControlProps = {
  onStatusChange?: (status: { connected: boolean; virtualCameraActive: boolean }) => void;
};

export function ObsControl({ onStatusChange }: ObsControlProps) {
  const requestIdRef = useRef(0);
  const mountedRef = useRef(false);
  const [badge, setBadge] = useState<ManagedObsBadge>("idle");
  const [version, setVersion] = useState("");
  const [virtualCameraActive, setVirtualCameraActive] = useState(false);
  const [prerequisites, setPrerequisites] = useState<PrerequisiteStatus | null>(null);
  const [working, setWorking] = useState(true);
  const [message, setMessage] = useState("正在检查客户端专用 OBS…");

  const applyManagedState = useCallback((state: ManagedObsState) => {
    if (!mountedRef.current) return;
    if (state.status === "ready") {
      setBadge("ready");
      setVersion(state.version);
      setVirtualCameraActive(state.virtualCameraActive);
      setMessage(
        state.virtualCameraActive
          ? "专用 OBS、数字人场景和虚拟摄像头已自动就绪。"
          : "专用 OBS 与数字人场景已就绪，虚拟摄像头当前已停止。"
      );
      return;
    }
    setVersion("");
    setVirtualCameraActive(false);
    if (state.status === "starting") {
      setBadge("starting");
      setMessage(`正在启动专用 OBS（${state.attempt}/${state.maxAttempts}）…`);
      return;
    }
    if (state.status === "blocked-by-external-obs") {
      setBadge("failed");
      setMessage("检测到其他 OBS 正在运行。请先关闭你自己的 OBS，再重新自动连接。");
      return;
    }
    if (state.status === "not-installed") {
      setBadge("failed");
      setMessage("客户端中的专用 OBS 资源缺失，请重新安装客户端。");
      return;
    }
    if (state.status === "failed") {
      setBadge(failureNeedsAuthorization(state) ? "needs-authorization" : "failed");
      setMessage(formatManagedObsFailure(state));
      return;
    }
    setBadge("idle");
    setMessage(state.status === "stopped" ? "专用 OBS 已停止。" : "专用 OBS 尚未启动。");
  }, []);

  const ensureManagedObs = useCallback(async (requestId: number) => {
    const bridge = getManagedObsDesktopBridge();
    if (!bridge) {
      if (requestId === requestIdRef.current) {
        setBadge("idle");
        setMessage("浏览器模式无法控制专用 OBS，请使用 Windows 桌面客户端。");
      }
      return;
    }

    setBadge("starting");
    setMessage("正在启动客户端专用 OBS…");
    let poll: number | undefined;
    let polling = true;
    try {
      const current = await bridge.getManagedObsState();
      if (requestId !== requestIdRef.current) return;
      if (current.status === "ready") {
        applyManagedState(current);
        return;
      }
      applyManagedState(current);
      setBadge("connecting");
      setMessage("正在等待专用 OBS 开放安全连接…");
      poll = window.setInterval(() => {
        void bridge.getManagedObsState()
          .then((state) => {
            if (polling && requestId === requestIdRef.current) applyManagedState(state);
          })
          .catch(() => undefined);
      }, 750);
      const state = await bridge.ensureManagedObs();
      if (requestId === requestIdRef.current) applyManagedState(state);
    } catch {
      if (requestId === requestIdRef.current) {
        setBadge("failed");
        setMessage(formatUnexpectedObsError("连接专用 OBS"));
      }
    } finally {
      polling = false;
      if (poll !== undefined) window.clearInterval(poll);
    }
  }, [applyManagedState]);

  const initialize = useCallback(async (requestId: number) => {
    const bridge = getManagedObsDesktopBridge();
    setWorking(true);
    if (!bridge) {
      if (requestId === requestIdRef.current) {
        setBadge("idle");
        setMessage("浏览器模式无法控制专用 OBS，请使用 Windows 桌面客户端。");
        setWorking(false);
      }
      return;
    }
    setBadge("starting");
    setMessage("正在检测 OBS 资源与虚拟摄像头注册状态…");
    try {
      const status = await bridge.getPrerequisiteStatus();
      if (requestId !== requestIdRef.current) return;
      setPrerequisites(status);
      if (!status.obsBundled) {
        setBadge("failed");
        setMessage("客户端中的专用 OBS 资源缺失，请重新安装客户端。");
        return;
      }
      if (!status.virtualCameraRegistered) {
        setBadge("needs-authorization");
        setMessage("专用 OBS 已内置，但虚拟摄像头尚未注册。请授权 Windows 完成注册。");
        return;
      }
      await ensureManagedObs(requestId);
    } catch {
      if (requestId === requestIdRef.current) {
        setBadge("failed");
        setMessage(formatUnexpectedObsError("检测 OBS 环境"));
      }
    } finally {
      if (requestId === requestIdRef.current) setWorking(false);
    }
  }, [ensureManagedObs]);

  useEffect(() => {
    mountedRef.current = true;
    const requestId = ++requestIdRef.current;
    void initialize(requestId);
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, [initialize]);

  useEffect(() => {
    onStatusChange?.({
      connected: badge === "ready",
      virtualCameraActive
    });
  }, [badge, virtualCameraActive, onStatusChange]);

  useEffect(() => {
    if (badge !== "ready") return;
    const bridge = getManagedObsDesktopBridge();
    if (!bridge) return;
    let active = true;
    const timer = window.setInterval(() => {
      void bridge.getManagedObsState()
        .then((state) => {
          if (active) applyManagedState(state);
        })
        .catch(() => {
          if (!active || !mountedRef.current) return;
          setBadge("failed");
          setMessage(formatUnexpectedObsError("读取 OBS 状态"));
        });
    }, 2_500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [applyManagedState, badge]);

  useEffect(() => {
    if (badge !== "ready") return;
    const bridge = getManagedObsDesktopBridge();
    if (!bridge) return;
    const managedBridge = bridge;
    function routeIntervention(event: Event) {
      const action = (event as CustomEvent<{ action?: InterventionAction }>).detail?.action;
      if (!action || !["begin", "end", "resume", "mute"].includes(action)) return;
      void managedBridge.setManagedObsInterventionRouting(action)
        .then((state) => {
          applyManagedState(state);
          if (state.status !== "ready") return;
          if (!mountedRef.current) return;
          setMessage(
            action === "begin"
              ? "人工麦克风已接入虚拟输出。"
              : action === "resume"
                ? "AI 音频已恢复。"
                : "输出已保持静音。"
          );
        })
        .catch(() => {
          if (mountedRef.current) setMessage(formatUnexpectedObsError("人工介入音频切换"));
        });
    }
    window.addEventListener("ai-intervention", routeIntervention);
    return () => window.removeEventListener("ai-intervention", routeIntervention);
  }, [applyManagedState, badge]);

  async function reconnectManagedObs() {
    if (working) return;
    setWorking(true);
    const requestId = ++requestIdRef.current;
    setBadge("connecting");
    setMessage("正在重新连接专用 OBS…");
    try {
      await ensureManagedObs(requestId);
    } finally {
      if (requestId === requestIdRef.current) setWorking(false);
    }
  }

  async function registerVirtualCameraAndConnect() {
    const bridge = getManagedObsDesktopBridge();
    if (!bridge || working) return;
    setWorking(true);
    setBadge("needs-authorization");
    setMessage("正在验证 OBS 官方组件，Windows 随后会请求管理员授权…");
    const requestId = ++requestIdRef.current;
    try {
      const result = await bridge.installPrerequisite("obs");
      if (!result.installed) {
        setMessage(formatPrerequisiteInstallError(result.error));
        return;
      }
      const status = await bridge.getPrerequisiteStatus();
      if (requestId !== requestIdRef.current) return;
      setPrerequisites(status);
      if (!status.virtualCameraRegistered) {
        setBadge("needs-authorization");
        setMessage("管理员操作已完成，但 Windows 尚未枚举到 OBS 虚拟摄像头。请重新授权注册。");
        return;
      }
      await ensureManagedObs(requestId);
    } catch {
      if (requestId === requestIdRef.current) {
        setBadge("needs-authorization");
        setMessage(formatUnexpectedObsError("注册 OBS 虚拟摄像头"));
      }
    } finally {
      if (requestId === requestIdRef.current) setWorking(false);
    }
  }

  async function toggleVirtualCamera() {
    const bridge = getManagedObsDesktopBridge();
    if (!bridge || working) return;
    const next = !virtualCameraActive;
    setWorking(true);
    setMessage(next ? "正在启动 OBS 虚拟摄像头…" : "正在停止 OBS 虚拟摄像头…");
    try {
      const result = await bridge.setManagedObsVirtualCamera(next);
      if (!mountedRef.current) return;
      applyManagedState(result);
      if (result.status !== "ready") return;
      const active = result.virtualCameraActive;
      setVirtualCameraActive(active);
      setMessage(active ? "OBS 虚拟摄像头已启动。" : "OBS 虚拟摄像头已停止。会议信号将暂时不可见。");
    } catch {
      if (mountedRef.current) setMessage(formatUnexpectedObsError(next ? "启动虚拟摄像头" : "停止虚拟摄像头"));
    } finally {
      if (mountedRef.current) setWorking(false);
    }
  }

  async function stopManagedObs() {
    const bridge = getManagedObsDesktopBridge();
    if (!bridge || working) return;
    setWorking(true);
    setMessage("正在停止客户端专用 OBS…");
    try {
      const result = await bridge.stopManagedObs();
      applyManagedState(result);
    } catch {
      if (mountedRef.current) setMessage(formatUnexpectedObsError("停止专用 OBS"));
    } finally {
      if (mountedRef.current) setWorking(false);
    }
  }

  async function resetManagedObs() {
    const bridge = getManagedObsDesktopBridge();
    if (!bridge || working) return;
    const requestId = ++requestIdRef.current;
    setWorking(true);
    setBadge("starting");
    setMessage("正在重置专用 OBS 配置并重新启动…");
    try {
      const state = await bridge.resetManagedObsConfig();
      if (requestId === requestIdRef.current) applyManagedState(state);
    } catch {
      if (requestId === requestIdRef.current) {
        setBadge("failed");
        setMessage(formatUnexpectedObsError("重置专用 OBS 配置"));
      }
    } finally {
      if (requestId === requestIdRef.current) setWorking(false);
    }
  }

  const connected = badge === "ready";
  const needsVirtualCameraRegistration = prerequisites?.obsBundled === true
    && (prerequisites.virtualCameraRegistered === false || badge === "needs-authorization");
  const badgeClass = badge === "ready"
    ? "connected"
    : badge === "starting" || badge === "connecting"
      ? "connecting"
      : badge;

  return (
    <article className="card obsControl">
      <div className="cardHeading">
        <h2>OBS 虚拟摄像头</h2>
        <span className={`obsState ${badgeClass}`} data-state={badge} aria-live="polite">
          {managedObsBadgeLabel(badge, version)}
        </span>
      </div>

      {needsVirtualCameraRegistration && (
        <div className="obsActions">
          <button disabled={working} onClick={() => void registerVirtualCameraAndConnect()}>
            {working ? "正在等待授权…" : "管理员授权注册并连接"}
          </button>
        </div>
      )}

      {!connected && !needsVirtualCameraRegistration && (
        <div className="obsActions">
          <button disabled={working || prerequisites?.obsBundled === false} onClick={() => void reconnectManagedObs()}>
            {working ? "正在连接…" : "重新自动连接"}
          </button>
          <button className="ghost" disabled={working || prerequisites?.obsBundled === false} onClick={() => void resetManagedObs()}>
            重置专用 OBS 配置并重启
          </button>
        </div>
      )}

      {connected && (
        <div className="obsActions">
          <button className="secondary" disabled={working} onClick={() => void toggleVirtualCamera()}>
            {virtualCameraActive ? "停止虚拟摄像头" : "启动虚拟摄像头"}
          </button>
          <button className="ghost" disabled={working} onClick={() => void stopManagedObs()}>
            停止专用 OBS
          </button>
        </div>
      )}

      <div className="obsMessage" aria-live="polite">
        <i className={virtualCameraActive ? "active" : ""} />
        <p>{message}</p>
      </div>
      <p className="muted">
        会议软件中选择“OBS Virtual Camera”。连接凭据由 Windows 安全存储保护，只由客户端主进程使用，不会发送到页面或写入应用日志。
      </p>
    </article>
  );
}
