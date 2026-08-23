"use client";

import { useEffect, useRef, useState } from "react";
import { getDesktopBridge } from "./bridge-session";
import {
  armAutoBridge,
  disarmAutoBridge,
  loadAutoBridgeSoftware,
  subscribeAutoBridgeStore,
  MEETING_EXECUTABLE_NAMES,
  MEETING_SOFTWARE_LABELS
} from "./auto-bridge-store";
import { getAutoBridgeStatus, subscribeAutoBridgeStatus } from "./auto-bridge-controller";
import { getVirtualAudioSetupStatus, subscribeVirtualAudioSetup } from "../audio/virtual-audio-auto-setup";
import { getSnapshotReadiness, loadReadinessSnapshot } from "../readiness/readiness-snapshot";

/** 自动预选：挂载后探测受支持会议进程，用户尚未选择时替其武装。 */
const PRESELECT_MAX_ROUNDS = 6;
const PRESELECT_INTERVAL_MS = 5_000;

export function MeetingBridgeCard() {
  const [desktopAvailable, setDesktopAvailable] = useState(false);
  const [software, setSoftware] = useState("");
  const [autoStatus, setAutoStatus] = useState(getAutoBridgeStatus);
  const [audioSetup, setAudioSetup] = useState(getVirtualAudioSetupStatus);
  const [virtualAudioReady, setVirtualAudioReady] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const userSelectedRef = useRef(false);
  const selectRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (!selectRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    setDesktopAvailable(Boolean(getDesktopBridge()));
    setSoftware(loadAutoBridgeSoftware());
    if (loadAutoBridgeSoftware()) userSelectedRef.current = true;
    const stopStore = subscribeAutoBridgeStore(() => setSoftware(loadAutoBridgeSoftware()));
    const stopAutoStatus = subscribeAutoBridgeStatus(() => setAutoStatus(getAutoBridgeStatus()));
    const stopAudioSetup = subscribeVirtualAudioSetup(() => setAudioSetup(getVirtualAudioSetupStatus()));
    const snapshotTimer = window.setInterval(() => {
      setVirtualAudioReady(getSnapshotReadiness(loadReadinessSnapshot()).virtualAudioReady);
    }, 2_000);
    return () => {
      stopStore();
      stopAutoStatus();
      stopAudioSetup();
      window.clearInterval(snapshotTimer);
    };
  }, []);

  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge) return;
    const desktopBridge = bridge; // 保留空值收窄供异步闭包使用
    let round = 0;
    let timer: number | null = null;
    let disposed = false;
    async function probe() {
      if (disposed) return;
      round += 1;
      try {
        if (!userSelectedRef.current && !loadAutoBridgeSoftware()) {
          const processes = await desktopBridge.listMeetingProcesses();
          if (disposed) return;
          const detected = processes[0];
          if (detected && MEETING_EXECUTABLE_NAMES.has(detected.name.toLowerCase())) {
            armAutoBridge(detected.name);
            userSelectedRef.current = true;
            return;
          }
        }
      } catch {
        // 探测失败不影响后续轮次
      }
      if (!userSelectedRef.current && !loadAutoBridgeSoftware() && round < PRESELECT_MAX_ROUNDS) {
        timer = window.setTimeout(() => void probe(), PRESELECT_INTERVAL_MS);
      }
    }
    void probe();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  function handleSoftwareChange(value: string) {
    userSelectedRef.current = true;
    if (value) {
      setSoftware(armAutoBridge(value));
    } else {
      disarmAutoBridge();
      setSoftware("");
    }
  }

  const captured = autoStatus.state === "captured";
  const softwareLabel = software ? MEETING_SOFTWARE_LABELS[software] || software : "";
  const audioValue = virtualAudioReady ? "已安装" : audioSetup.text || "待安装";
  const audioNeedsAttention = audioSetup.state === "failed" || audioSetup.state === "reboot-pending";

  return (
    <article className="card" id="workspace-meeting-bridge">
      <div className="cardHeading">
        <h2>会议接入</h2>
      </div>
      {!desktopAvailable ? (
        <p className="muted">请在 Windows 客户端中使用：会议进程捕获与虚拟声卡自动安装仅在客户端内生效。</p>
      ) : (
        <>
          <div className="field">
            会议软件
            <div className="selectBox" ref={selectRef}>
              <button
                type="button"
                className="selectBoxTrigger"
                aria-haspopup="listbox"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((value) => !value)}
              >
                {softwareLabel || "未选择"}
              </button>
              <span className="selectCaret" aria-hidden>▼</span>
              {menuOpen ? (
                <div className="selectMenu" role="listbox" aria-label="会议软件">
                  <button
                    type="button"
                    role="option"
                    aria-selected={!software}
                    className={software ? "" : "selected"}
                    onClick={() => {
                      handleSoftwareChange("");
                      setMenuOpen(false);
                    }}
                  >
                    未选择
                  </button>
                  {[...MEETING_EXECUTABLE_NAMES].map((name) => (
                    <button
                      key={name}
                      type="button"
                      role="option"
                      aria-selected={software === name}
                      className={software === name ? "selected" : ""}
                      onClick={() => {
                        handleSoftwareChange(name);
                        setMenuOpen(false);
                      }}
                    >
                      {MEETING_SOFTWARE_LABELS[name] || name}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
          {captured ? (
            <p className="autoHint"><i aria-hidden />已自动检测到{softwareLabel}正在运行</p>
          ) : null}
        </>
      )}
      <div className="bridgeRow">
        <span>自动桥接</span>
        <strong className={captured ? "ok" : ""}>{software ? autoStatus.text : "未武装"}</strong>
      </div>
      <div className="bridgeRow">
        <span>虚拟声卡</span>
        <strong className={virtualAudioReady ? "ok" : ""}>{audioValue}</strong>
      </div>
      {software === "wemeetapp.exe" ? (
        <p className="muted">
          腾讯会议设备：扬声器选系统默认/Realtek，麦克风选 CABLE Output；请勿把会议扬声器设为 CABLE In。
        </p>
      ) : null}
      {autoStatus.state === "needs-manual" || audioNeedsAttention ? (
        <a className="textLink" href="/settings#settings-rtc-bridge-section">打开设置处理 →</a>
      ) : null}
    </article>
  );
}
