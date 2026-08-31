"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { AudioRouteControl } from "../../features/audio/audio-route-control";
import { VoiceCloneControl } from "../../features/audio/voice-clone-control";
import { describeTtsError } from "../../features/audio/tts-error";
import { ObsControl } from "../../features/obs/obs-control";
import { VirtualCameraPreview } from "../../features/obs/virtual-camera-preview";
import { getInterviewReadiness } from "../../features/readiness/interview-readiness";
import { getSnapshotReadiness, loadReadinessSnapshot, setReadinessVerification } from "../../features/readiness/readiness-snapshot";
import {
  loadOutputMode,
  saveOutputMode,
  subscribeOutputMode,
  type OutputMode
} from "../../features/readiness/output-mode";
import { AVATAR_ACCEPT, classifyAvatarSelection, type AvatarSelectionResult } from "../../lib/avatar-policy";
import { AppChrome } from "../../features/settings/app-chrome";
import { AppNavigation } from "../../features/settings/app-navigation";
import {
  describeNetwork,
  getNetworkQuality,
  networkStatus,
  setManagementNetwork,
  subscribeNetworkQuality
} from "../../features/rtc/network-quality";

type AvatarMetadata = { available: boolean; kind?: "image" | "video"; originalName?: string; size?: number; version?: string };
type SelectedAvatar = AvatarSelectionResult & { name: string; size: number };
type Diagnostics = {
  server: boolean;
  managementReachable: boolean;
  stageConnected: boolean;
  ttsSupported: boolean;
  voiceCount: number;
  sapiConfigured: boolean;
  sapiVoiceCount: number;
  ttsState: "idle" | "speaking" | "ready" | "error";
  ttsError: string;
  lastSpeechAt: number;
  mediaReady: boolean;
};
const emptyDiagnostics: Diagnostics = {
  server: false,
  managementReachable: false,
  stageConnected: false,
  ttsSupported: false,
  voiceCount: 0,
  sapiConfigured: false,
  sapiVoiceCount: 0,
  ttsState: "idle",
  ttsError: "",
  lastSpeechAt: 0,
  mediaReady: false
};

export default function SettingsPage() {
  const [avatar, setAvatar] = useState<AvatarMetadata>({ available: false });
  const [diagnostics, setDiagnostics] = useState(emptyDiagnostics);
  const [uploading, setUploading] = useState(false);
  const [selectedAvatar, setSelectedAvatar] = useState<SelectedAvatar | null>(null);
  const [testingSpeech, setTestingSpeech] = useState(false);
  const [speechTestRequestedAt, setSpeechTestRequestedAt] = useState(0);
  const [obsConnected, setObsConnected] = useState(false);
  const [virtualCameraActive, setVirtualCameraActive] = useState(false);
  const [virtualCameraVerified, setVirtualCameraVerified] = useState(false);
  const [virtualAudioReady, setVirtualAudioReady] = useState(false);
  const [meetingPreviewConfirmed, setMeetingPreviewConfirmed] = useState(false);
  const [diagnosticsLoaded, setDiagnosticsLoaded] = useState(false);
  const [outputMode, setOutputMode] = useState<OutputMode>("real");
  const [error, setError] = useState("");
  const [network, setNetwork] = useState(getNetworkQuality);
  const snapshotLoadedRef = useRef(false);
  const virtualMode = outputMode === "virtual";

  const handleObsStatus = useCallback((status: { connected: boolean; virtualCameraActive: boolean }) => {
    if (!snapshotLoadedRef.current) return;
    setObsConnected(status.connected); setVirtualCameraActive(status.virtualCameraActive);
    setReadinessVerification("obsConnected", status.connected); setReadinessVerification("virtualCameraActive", status.virtualCameraActive);
    if (!status.virtualCameraActive) setVirtualCameraVerified(false);
  }, []);
  const handleCameraVerified = useCallback((ready: boolean) => { if (!snapshotLoadedRef.current) return; setVirtualCameraVerified(ready); setReadinessVerification("virtualCameraVerified", ready); }, []);
  const handleVirtualAudioReady = useCallback((ready: boolean) => { if (!snapshotLoadedRef.current) return; setVirtualAudioReady(ready); setReadinessVerification("virtualAudioReady", ready); }, []);

  const speechReady = (diagnostics.sapiConfigured || (diagnostics.ttsSupported && diagnostics.voiceCount > 0)) && diagnostics.ttsState !== "error" && ((speechTestRequestedAt > 0 && diagnostics.lastSpeechAt >= speechTestRequestedAt) || getSnapshotReadiness(loadReadinessSnapshot()).speechReady);

  useEffect(() => {
    const snapshot = getSnapshotReadiness(loadReadinessSnapshot());
    setObsConnected(snapshot.obsConnected); setVirtualCameraActive(snapshot.virtualCameraActive); setVirtualCameraVerified(snapshot.virtualCameraVerified); setVirtualAudioReady(snapshot.virtualAudioReady); setMeetingPreviewConfirmed(snapshot.meetingPreviewConfirmed);
    snapshotLoadedRef.current = true;
    setOutputMode(loadOutputMode());
    fetch("/api/avatar", { cache: "no-store" }).then((response) => response.json()).then(setAvatar).catch(() => setError("无法读取助手素材"));
    return subscribeOutputMode(() => setOutputMode(loadOutputMode()));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("focus") !== "virtual") return;
    const section = document.getElementById("settings-output-mode");
    section?.scrollIntoView({ behavior: "smooth", block: "start" });
    section?.classList.add("settingsFocus");
    const timer = window.setTimeout(() => section?.classList.remove("settingsFocus"), 2400);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => subscribeNetworkQuality(() => setNetwork(getNetworkQuality())), []);
  useEffect(() => { if (diagnosticsLoaded) setReadinessVerification("speechReady", speechReady); }, [diagnosticsLoaded, speechReady]);

  useEffect(() => {
    let active = true;
    async function refreshDiagnostics() {
      try {
        const [healthResponse, stageResponse] = await Promise.all([
          fetch("/api/health", { cache: "no-store" }),
          fetch("/api/stage-status", { cache: "no-store" })
        ]);
        const health = await healthResponse.json();
        const stage = await stageResponse.json();
        if (!active) return;
        setDiagnostics({
          server: healthResponse.ok && health.status === "ok",
          managementReachable: Boolean(health.managementReachable),
          stageConnected: Boolean(stage.connected),
          ttsSupported: Boolean(stage.ttsSupported),
          voiceCount: Number(stage.voiceCount || 0),
          sapiConfigured: Boolean(health.ttsConfigured),
          sapiVoiceCount: Number(health.ttsVoiceCount || 0),
          ttsState: ["idle", "speaking", "ready", "error"].includes(stage.ttsState) ? stage.ttsState : "idle",
          ttsError: String(stage.ttsError || ""),
          lastSpeechAt: Number(stage.lastSpeechAt || 0),
          mediaReady: Boolean(stage.mediaReady)
        });
        setManagementNetwork({
          reachable: Boolean(health.managementReachable),
          rttMs: Number.isFinite(Number(health.managementRttMs)) ? Number(health.managementRttMs) : null
        });
        setDiagnosticsLoaded(true);
      } catch {
        if (active) {
          setDiagnostics((current) => ({ ...current, server: false, stageConnected: false }));
          setManagementNetwork({ reachable: false, rttMs: null });
          setDiagnosticsLoaded(true);
        }
      }
    }
    void refreshDiagnostics(); const timer = window.setInterval(refreshDiagnostics, 2_500); return () => { active = false; window.clearInterval(timer); };
  }, []);

  function handleOutputModeChange(mode: OutputMode) {
    saveOutputMode(mode);
    setOutputMode(mode);
  }

  async function uploadAvatar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const file = (form.elements.namedItem("avatar") as HTMLInputElement).files?.[0]; if (!file || !selectedAvatar?.valid) return;
    setUploading(true); setError(""); try { const body = new FormData(); body.append("avatar", file); const response = await fetch("/api/avatar", { method: "POST", body }); const data = await response.json(); if (!response.ok) throw new Error(data.message || "上传失败"); setAvatar(data); setSelectedAvatar(null); form.reset(); } catch (cause) { setError(cause instanceof Error ? cause.message : "上传失败"); } finally { setUploading(false); }
  }
  async function clearAvatar() { setUploading(true); setError(""); try { const response = await fetch("/api/avatar", { method: "DELETE" }); const data = await response.json(); if (!response.ok) throw new Error(data.message || "恢复失败"); setAvatar(data); } catch (cause) { setError(cause instanceof Error ? cause.message : "恢复失败"); } finally { setUploading(false); } }
  async function playTestSpeech() { setTestingSpeech(true); setSpeechTestRequestedAt(0); setError(""); try { const response = await fetch("/api/stage-test-speech", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "你好，这是一段虚拟助手音视频线路测试。" }) }); const data = await response.json(); if (!response.ok) throw new Error(data.message || "测试语音发送失败"); setSpeechTestRequestedAt(Number(data.createdAt || Date.now())); } catch (cause) { setError(cause instanceof Error ? cause.message : "测试语音发送失败"); } finally { setTestingSpeech(false); } }

  const readiness = getInterviewReadiness({ outputMode, stageConnected: diagnostics.stageConnected, mediaReady: diagnostics.mediaReady, speechReady, obsConnected, virtualCameraActive, virtualCameraVerified, virtualAudioReady, meetingPreviewConfirmed });
  return <main className="console settingsPage">
    <AppChrome current="settings" />
    <header className="topbar"><div><p className="eyebrow">CONFIGURATION</p><h1>设置与检测</h1></div><AppNavigation current="settings" /></header>
    {error && <p className="error" role="alert">{error}</p>}
    <section className={`readinessBanner ${readiness.ready ? "ready" : ""}`}><div><strong>{readiness.ready ? (virtualMode ? "虚拟助手环境已就绪" : "助手环境已就绪") : `还有 ${readiness.missing.length} 项需要处理`}</strong><span>{readiness.ready ? (virtualMode ? "可以返回工作台开始互动。" : "会议可用自己的摄像头；虚拟声卡可选，用于把 AI 语音送进会议。") : readiness.missing.slice(0, 3).map((item) => item.label).join("、")}</span></div><a className="buttonLink" href="/">返回虚拟助手工作台</a></section>
    <section className="settingsGrid">
      <SettingSection number="01" title="会议画面" detail="二选一只影响画面。真实摄像头也可配合下方虚拟声卡输出 AI 语音。" id="settings-output-mode">
        <article className="card outputModeCard">
          <div className="outputModeChoices" role="radiogroup" aria-label="会议画面">
            <label className={`outputModeChoice ${outputMode === "real" ? "selected" : ""}`}>
              <input type="radio" name="outputMode" checked={outputMode === "real"} onChange={() => handleOutputModeChange("real")} />
              <span className="outputModeCopy"><strong>使用自己的真实摄像头</strong><span>会议软件里选普通摄像头。AI 对话、字幕与追问照常；麦克风仍可选虚拟声卡送 AI 语音。</span></span>
            </label>
            <label className={`outputModeChoice ${virtualMode ? "selected" : ""}`}>
              <input type="radio" name="outputMode" checked={virtualMode} onChange={() => handleOutputModeChange("virtual")} />
              <span className="outputModeCopy"><strong>使用 OBS 虚拟摄像头输出助手画面</strong><span>会议软件里选 OBS Virtual Camera。舞台默认形象即可，上传图片或视频可选。</span></span>
            </label>
          </div>
        </article>
      </SettingSection>
      <SettingSection number="02" title="系统诊断" detail="模型、转写和播报由当前启用的 LiveKit Agent 语音线路统一执行，客户端只检查连接与媒体设备。">
        <article className="card diagnostics">
          <div className="checks">
            <Check label="本地服务" ok={diagnostics.server} detail={diagnostics.server ? "正常" : "不可用"} />
            <Check label="管理端" ok={diagnostics.managementReachable} detail={diagnostics.managementReachable ? "可连接；语音线路由管理端统一维护" : "不可达，请检查网络或管理端服务"} />
            <Check label="网络" ok={networkStatus(network) === "ok"} warn={networkStatus(network) === "warn"} detail={describeNetwork(network)} />
            <Check label="播报引擎" ok={diagnostics.stageConnected} detail={diagnostics.stageConnected ? "主工作台播放控制器在线" : "请保持主工作台打开"} />
            {virtualMode ? (
              <>
                <Check
                  label="中文语音"
                  ok={speechReady}
                  detail={
                    diagnostics.ttsState === "error"
                      ? describeTtsError(diagnostics.ttsError)
                      : speechReady
                        ? "最近实测播放成功"
                        : diagnostics.sapiConfigured
                          ? "中文语音已配置，等待实测"
                          : "当前舞台不支持 TTS"
                  }
                />
                <Check
                  label="画面素材"
                  ok={diagnostics.stageConnected && diagnostics.mediaReady}
                  detail={diagnostics.mediaReady ? "已就绪，上传图片或视频可选" : "仍在加载或格式不兼容"}
                />
              </>
            ) : null}
          </div>
          <button disabled={!diagnostics.stageConnected || testingSpeech} onClick={() => void playTestSpeech()}>
            {testingSpeech ? "正在发送…" : "播放测试语音"}
          </button>
        </article>
      </SettingSection>
      <SettingSection number="03" title="助手声音" detail="阿里云语音使用控制台音色直接播报；豆包线路仍可用真实麦克风按稿刻录。">
        <VoiceCloneControl />
      </SettingSection>
      {virtualMode && <SettingSection number="04" title="助手形象" detail="可选。不上传则使用默认助手形象。"><article className="card mediaSetup"><div className="cardHeading"><h2>当前画面</h2><span>{avatar.available ? "已启用" : "默认形象"}</span></div><div className="mediaPreview">{avatar.available && avatar.kind === "video" && <video src={`/api/avatar/media?v=${avatar.version}`} autoPlay loop muted playsInline />}{avatar.available && avatar.kind === "image" && <img src={`/api/avatar/media?v=${avatar.version}`} alt="当前助手素材" />}{!avatar.available && <span>当前使用默认助手形象</span>}</div><form onSubmit={uploadAvatar}><div className="uploadGuidance"><strong>支持图片 JPG/PNG/WebP，或视频 MP4/WebM；单个文件最大 50MB。</strong><span>推荐 16:9、1280×720；视频将静音循环播放；素材仅保存在本机。</span></div><input name="avatar" type="file" accept={AVATAR_ACCEPT} onChange={(event) => { const file = event.currentTarget.files?.[0]; if (!file) { setSelectedAvatar(null); return; } setSelectedAvatar({ ...classifyAvatarSelection(file), name: file.name, size: file.size }); }} />{selectedAvatar && <p className={`selectedFile ${selectedAvatar.valid ? "" : "invalid"}`} aria-live="polite">{selectedAvatar.valid ? `已选择：${selectedAvatar.name} · ${selectedAvatar.kindLabel} · ${Math.max(1, Math.round(selectedAvatar.size / 1024))}KB` : selectedAvatar.message}</p>}<button disabled={uploading || !selectedAvatar?.valid}>{uploading ? "正在上传…" : "上传并应用"}</button></form>{avatar.available && <><p className="fileMeta">{avatar.originalName} · {Math.max(1, Math.round((avatar.size || 0) / 1024))}KB</p><button className="secondary" disabled={uploading} onClick={clearAvatar}>恢复默认形象</button></>}</article></SettingSection>}
      {virtualMode && <SettingSection number="05" title="OBS 与舞台" detail="自动连接；未安装时可一键安装并继续。"><ObsControl onStatusChange={handleObsStatus} /></SettingSection>}
      <SettingSection number={virtualMode ? "06" : "04"} title={virtualMode ? "摄像头与音频" : "虚拟声卡"} detail={virtualMode ? "一键授权并检查会议软件最终读取到的画面和声音。" : "真实摄像头模式下也可检测虚拟麦克风，把 AI 语音送进会议。"}>
        <div className="settingsPair">
          {virtualMode ? <VirtualCameraPreview active={virtualCameraActive} onVerifiedChange={handleCameraVerified} /> : null}
          <AudioRouteControl onReadyChange={handleVirtualAudioReady} />
        </div>
      </SettingSection>
    </section>
  </main>;
}

function SettingSection({ number, title, detail, children, id }: { number: string; title: string; detail: string; children: React.ReactNode; id?: string }) { return <div className="settingsSection" id={id}><div className="sectionIntro"><span>{number}</span><div><h2>{title}</h2><p>{detail}</p></div></div>{children}</div>; }
function Check({ label, ok, warn, detail }: { label: string; ok: boolean; warn?: boolean; detail: string }) { return <div className="check"><i className={ok ? "ok" : warn ? "warn" : ""}>{ok ? "✓" : "!"}</i><div><strong>{label}</strong><span>{detail}</span></div></div>; }
