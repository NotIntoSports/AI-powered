"use client";

import { useEffect, useState } from "react";
import { loadRemoteMonitorEnabled } from "../audio/remote-monitor.ts";
import {
  describeNetwork,
  getNetworkQuality,
  subscribeNetworkQuality
} from "./network-quality.ts";
import type { SubtitleProvider } from "../../lib/subtitles/transport.ts";
import {
  getBridgeSessionHandle,
  getDesktopBridge,
  providerLabel,
  startBridgeSession,
  stopBridgeSession,
  type MeetingProcess
} from "./bridge-session.ts";
import {
  loadAutoBridgeEnabled,
  loadAutoBridgeSoftware,
  saveAutoBridgeEnabled,
  saveAutoBridgeSoftware,
  subscribeAutoBridgeStore,
  MEETING_EXECUTABLE_NAMES,
  MEETING_SOFTWARE_LABELS
} from "./auto-bridge-store.ts";
import {
  getAutoBridgeStatus,
  subscribeAutoBridgeStatus
} from "./auto-bridge-controller.tsx";

export function RtcBridgeControl() {
  const [processes, setProcesses] = useState<MeetingProcess[]>([]);
  const [pid, setPid] = useState(0);
  const [status, setStatus] = useState("请选择正在通话的会议软件进程。");
  const [running, setRunning] = useState(false);
  const [provider, setProvider] = useState<SubtitleProvider>("volcengine");
  const [network, setNetwork] = useState(getNetworkQuality);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoSoftware, setAutoSoftware] = useState("");
  const [autoStatus, setAutoStatus] = useState(getAutoBridgeStatus);

  useEffect(() => subscribeNetworkQuality(() => setNetwork(getNetworkQuality())), []);

  useEffect(() => {
    setAutoEnabled(loadAutoBridgeEnabled());
    setAutoSoftware(loadAutoBridgeSoftware());
    const stopStore = subscribeAutoBridgeStore(() => {
      setAutoEnabled(loadAutoBridgeEnabled());
      setAutoSoftware(loadAutoBridgeSoftware());
    });
    const stopStatus = subscribeAutoBridgeStatus(() => setAutoStatus(getAutoBridgeStatus()));
    return () => { stopStore(); stopStatus(); };
  }, []);

  async function refresh() {
    const bridge = getDesktopBridge();
    if (!bridge) { setStatus("请在 Windows 客户端中使用音频桥接功能。"); return; }
    const result = await bridge.listMeetingProcesses();
    setProcesses(result);
    if (!result.some((item) => item.pid === pid)) setPid(result[0]?.pid || 0);
    setStatus(result.length ? "选择进程后可启动实时字幕。" : "未发现正在通话的受支持会议软件窗口。");
  }

  useEffect(() => {
    void refresh();
    return () => {
      if (getBridgeSessionHandle()?.owner === "manual") void stopBridgeSession();
    };
  }, []);

  async function start() {
    if (!pid) return;
    try {
      const handle = await startBridgeSession(pid, "manual", "interview", {
        onStatus: setStatus,
        onLevel: (peak) => setStatus(`${providerLabel(handle.provider)} 运行中 · 对方音量 ${Math.round(peak * 100)}%`),
        onProcessExited: () => void stop(),
        onTransportState: (state, reason) => {
          if (state === "reconnecting") setStatus("网络连接波动，正在重连…");
          if (state === "disconnected") {
            setStatus(`实时字幕连接已断开${reason ? `：${reason}` : ""}`);
            void stopBridgeSession().finally(() => setRunning(false));
          }
        }
      });
      setProvider(handle.provider);
      setRunning(true);
      setStatus(
        loadRemoteMonitorEnabled()
          ? `${providerLabel(handle.provider)} 运行中；本机正在播放对方声音（可在「监听与人工介入」关闭）。`
          : `${providerLabel(handle.provider)} 运行中；本机未播放对方声音，请用会议软件收听。`
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "启动失败");
    }
  }

  async function stop() {
    await stopBridgeSession();
    setRunning(false);
    setStatus("字幕和会议进程捕获已停止。");
  }

  return (
    <article className="card" id="settings-rtc-bridge">
      <div className="cardHeading"><h2>会议音频桥接</h2><span className={running ? "ready" : ""}>{running ? `${providerLabel(provider)} 运行中` : "未启动"}</span></div>
      <label>会议软件进程
        <select value={pid} disabled={running} onChange={(event) => setPid(Number(event.target.value))}>
          <option value={0}>请选择</option>
          {processes.map((process) => <option key={process.pid} value={process.pid}>{process.name} · {process.title} · PID {process.pid}</option>)}
        </select>
      </label>
      <label className="autoFollowup">
        <input
          type="checkbox"
          checked={autoEnabled}
          disabled={!autoSoftware && !autoEnabled}
          onChange={(event) => {
            setAutoEnabled(event.target.checked);
            saveAutoBridgeEnabled(event.target.checked);
          }}
        />
        <span>
          <strong>自动听取</strong>
          <small>检测到预选会议软件开启后自动捕获并推流；散会自动停止。</small>
        </span>
      </label>
      <label>预选会议软件
        <select
          value={autoSoftware}
          disabled={running}
          onChange={(event) => {
            setAutoSoftware(event.target.value);
            saveAutoBridgeSoftware(event.target.value);
          }}
        >
          <option value="">未选择（自动听取不生效）</option>
          {[...MEETING_EXECUTABLE_NAMES].map((name) => (
            <option key={name} value={name}>{MEETING_SOFTWARE_LABELS[name] || name}</option>
          ))}
        </select>
      </label>
      {autoEnabled ? (
        <p className="muted">自动状态：{autoStatus.text}</p>
      ) : null}
      <div className="obsActions">
        <button disabled={running || !pid} onClick={() => void start()}>启动实时字幕</button>
        <button className="secondary" disabled={!running} onClick={() => void stop()}>停止字幕</button>
        <button className="ghost" disabled={running} onClick={() => void refresh()}>刷新进程</button>
      </div>
      <p>{status}</p>
      <p className="networkMeter">{describeNetwork(network)}</p>
      <p className="muted">只捕获所选会议进程及其子进程；PCM 不落盘。线路由管理端 current provider 决定，一场互动中途不切换。若会议软件重启，请重新选择进程。对方声音是否本机播放由工作台「本机听到对方说话」开关控制（默认开启）。</p>
    </article>
  );
}
