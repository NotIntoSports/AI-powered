"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { AudioRouteControl } from "../../features/audio/audio-route-control";
import { describeTtsError } from "../../features/audio/tts-error";
import { MeetingHandoffControl } from "../../features/meeting/meeting-handoff-control";
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
type Diagnostics = { server: boolean; modelConfigured: boolean; stageConnected: boolean; ttsSupported: boolean; voiceCount: number; sapiConfigured: boolean; sapiVoiceCount: number; ttsState: "idle" | "speaking" | "ready" | "error"; ttsError: string; lastSpeechAt: number; mediaReady: boolean; transcriptionConfigured: boolean; transcriptionReady: boolean; transcriptionSource: "management" | "environment" | "whisper-cpp" | "none" };
const emptyDiagnostics: Diagnostics = { server: false, modelConfigured: false, stageConnected: false, ttsSupported: false, voiceCount: 0, sapiConfigured: false, sapiVoiceCount: 0, ttsState: "idle", ttsError: "", lastSpeechAt: 0, mediaReady: false, transcriptionConfigured: false, transcriptionReady: false, transcriptionSource: "none" };
const unusedVirtualCamera = "当前未使用虚拟摄像头";

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
  const handleMeetingPreviewConfirmed = useCallback((ready: boolean) => { if (!snapshotLoadedRef.current) return; setMeetingPreviewConfirmed(ready); setReadinessVerification("meetingPreviewConfirmed", ready); }, []);

  const speechReady = (diagnostics.sapiConfigured || (diagnostics.ttsSupported && diagnostics.voiceCount > 0)) && diagnostics.ttsState !== "error" && ((speechTestRequestedAt > 0 && diagnostics.lastSpeechAt >= speechTestRequestedAt) || getSnapshotReadiness(loadReadinessSnapshot()).speechReady);

  useEffect(() => {
    const snapshot = getSnapshotReadiness(loadReadinessSnapshot());
    setObsConnected(snapshot.obsConnected); setVirtualCameraActive(snapshot.virtualCameraActive); setVirtualCameraVerified(snapshot.virtualCameraVerified); setVirtualAudioReady(snapshot.virtualAudioReady); setMeetingPreviewConfirmed(snapshot.meetingPreviewConfirmed);
    snapshotLoadedRef.current = true;
    setOutputMode(loadOutputMode());
    fetch("/api/avatar", { cache: "no-store" }).then((response) => response.json()).then(setAvatar).catch(() => setError("无法读取数字人素材"));
    return subscribeOutputMode(() => setOutputMode(loadOutputMode()));
  }, []);
  useEffect(() => subscribeNetworkQuality(() => setNetwork(getNetworkQuality())), []);
  useEffect(() => { if (diagnosticsLoaded) setReadinessVerification("speechReady", speechReady); }, [diagnosticsLoaded, speechReady]);

  useEffect(() => {
    let active = true;
    async function refreshDiagnostics() {
      try {
        const [healthResponse, stageResponse] = await Promise.all([fetch("/api/health", { cache: "no-store" }), fetch("/api/stage-status", { cache: "no-store" })]);
        const health = await healthResponse.json(); const stage = await stageResponse.json(); if (!active) return;
        setDiagnostics({ server: healthResponse.ok && health.status === "ok", modelConfigured: Boolean(health.modelConfigured), stageConnected: Boolean(stage.connected), ttsSupported: Boolean(stage.ttsSupported), voiceCount: Number(stage.voiceCount || 0), sapiConfigured: Boolean(health.ttsConfigured), sapiVoiceCount: Number(health.ttsVoiceCount || 0), ttsState: ["idle", "speaking", "ready", "error"].includes(stage.ttsState) ? stage.ttsState : "idle", ttsError: String(stage.ttsError || ""), lastSpeechAt: Number(stage.lastSpeechAt || 0), mediaReady: Boolean(stage.mediaReady), transcriptionConfigured: Boolean(health.transcriptionConfigured), transcriptionReady: Boolean(health.transcriptionReady), transcriptionSource: health.transcriptionSource === "management" || health.transcriptionSource === "environment" || health.transcriptionSource === "whisper-cpp" ? health.transcriptionSource : "none" });
        setManagementNetwork({ reachable: Boolean(health.managementReachable), rttMs: Number.isFinite(Number(health.managementRttMs)) ? Number(health.managementRttMs) : null });
        setDiagnosticsLoaded(true);
      } catch { if (active) { setDiagnostics((current) => ({ ...current, server: false, stageConnected: false })); setManagementNetwork({ reachable: false, rttMs: null }); setDiagnosticsLoaded(true); } }
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
  async function playTestSpeech() { setTestingSpeech(true); setSpeechTestRequestedAt(0); setError(""); try { const response = await fetch("/api/stage-test-speech", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "你好，这是一段数字人音视频线路测试。" }) }); const data = await response.json(); if (!response.ok) throw new Error(data.message || "测试语音发送失败"); setSpeechTestRequestedAt(Number(data.createdAt || Date.now())); } catch (cause) { setError(cause instanceof Error ? cause.message : "测试语音发送失败"); } finally { setTestingSpeech(false); } }

  const readiness = getInterviewReadiness({ outputMode, modelConfigured: diagnostics.modelConfigured, stageConnected: diagnostics.stageConnected, mediaReady: diagnostics.mediaReady, speechReady, obsConnected, virtualCameraActive, virtualCameraVerified, virtualAudioReady, meetingPreviewConfirmed });
  return <main className="console settingsPage">
    <header className="topbar"><div><p className="eyebrow">CONFIGURATION</p><h1>设置与检测</h1></div><AppNavigation current="settings" /></header>
    {error && <p className="error" role="alert">{error}</p>}
    <section className={`readinessBanner ${readiness.ready ? "ready" : ""}`}><div><strong>{readiness.ready ? (virtualMode ? "数字人环境已就绪" : "助手环境已就绪") : `还有 ${readiness.missing.length} 项需要处理`}</strong><span>{readiness.ready ? (virtualMode ? "可以返回工作台开始互动。" : "会议将使用你自己的摄像头，可以返回工作台开始互动。") : readiness.missing.slice(0, 3).map((item) => item.label).join("、")}</span></div><a className="buttonLink" href="/">返回数字人工作台</a></section>
    <section className="settingsGrid">
      <SettingSection number="01" title="会议画面" detail="二选一。真实摄像头不替换会议画面；虚拟摄像头才输出数字人。">
        <article className="card outputModeCard">
          <div className="outputModeChoices" role="radiogroup" aria-label="会议画面">
            <label className={`outputModeChoice ${outputMode === "real" ? "selected" : ""}`}>
              <input type="radio" name="outputMode" checked={outputMode === "real"} onChange={() => handleOutputModeChange("real")} />
              <span className="outputModeCopy"><strong>使用自己的真实摄像头</strong><span>会议软件里选普通摄像头。本软件只提供字幕和追问，不上传数字人图片。</span></span>
            </label>
            <label className={`outputModeChoice ${virtualMode ? "selected" : ""}`}>
              <input type="radio" name="outputMode" checked={virtualMode} onChange={() => handleOutputModeChange("virtual")} />
              <span className="outputModeCopy"><strong>使用 OBS 虚拟摄像头输出数字人</strong><span>会议软件里选 OBS Virtual Camera。舞台默认形象即可，上传图片或视频可选。</span></span>
            </label>
          </div>
        </article>
      </SettingSection>
      <SettingSection number="02" title="系统诊断" detail="先查看当前状态，再处理未通过项目。"><article className="card diagnostics"><div className="checks"><Check label="本地服务" ok={diagnostics.server} detail={diagnostics.server ? "正常" : "不可用"} /><Check label="AI 模型" ok={diagnostics.modelConfigured} detail={diagnostics.modelConfigured ? "已由管理端配置" : "请在管理后台配置 AI 模型"} /><Check label="语音转写" ok={diagnostics.transcriptionReady} detail={transcriptionDetail(diagnostics)} /><Check label="网络" ok={networkStatus(network) === "ok"} warn={networkStatus(network) === "warn"} detail={describeNetwork(network)} /><Check label="数字人舞台" ok={virtualMode && diagnostics.stageConnected} warn={!virtualMode} detail={virtualMode ? (diagnostics.stageConnected ? "页面在线" : "请打开数字人舞台") : unusedVirtualCamera} /><Check label="中文语音" ok={virtualMode && speechReady} warn={!virtualMode} detail={virtualMode ? (diagnostics.ttsState === "error" ? describeTtsError(diagnostics.ttsError) : speechReady ? "最近实测播放成功" : diagnostics.sapiConfigured ? `SAPI ${diagnostics.sapiVoiceCount} 个中文声音，等待实测` : "当前舞台不支持 TTS") : unusedVirtualCamera} /><Check label="画面素材" ok={virtualMode && diagnostics.stageConnected && diagnostics.mediaReady} warn={!virtualMode} detail={virtualMode ? (diagnostics.mediaReady ? "已就绪，上传图片或视频可选" : "仍在加载或格式不兼容") : unusedVirtualCamera} /></div>{virtualMode && <button disabled={!diagnostics.stageConnected || testingSpeech} onClick={() => void playTestSpeech()}>{testingSpeech ? "正在发送…" : "播放测试语音"}</button>}</article></SettingSection>
      {virtualMode && <SettingSection number="03" title="数字人形象" detail="可选。不上传则使用默认数字人形象。"><article className="card mediaSetup"><div className="cardHeading"><h2>当前画面</h2><span>{avatar.available ? "已启用" : "默认形象"}</span></div><div className="mediaPreview">{avatar.available && avatar.kind === "video" && <video src={`/api/avatar/media?v=${avatar.version}`} autoPlay loop muted playsInline />}{avatar.available && avatar.kind === "image" && <img src={`/api/avatar/media?v=${avatar.version}`} alt="当前数字人素材" />}{!avatar.available && <span>当前使用默认数字人</span>}</div><form onSubmit={uploadAvatar}><div className="uploadGuidance"><strong>支持图片 JPG/PNG/WebP，或视频 MP4/WebM；单个文件最大 50MB。</strong><span>推荐 16:9、1280×720；视频将静音循环播放；素材仅保存在本机。</span></div><input name="avatar" type="file" accept={AVATAR_ACCEPT} onChange={(event) => { const file = event.currentTarget.files?.[0]; if (!file) { setSelectedAvatar(null); return; } setSelectedAvatar({ ...classifyAvatarSelection(file), name: file.name, size: file.size }); }} />{selectedAvatar && <p className={`selectedFile ${selectedAvatar.valid ? "" : "invalid"}`} aria-live="polite">{selectedAvatar.valid ? `已选择：${selectedAvatar.name} · ${selectedAvatar.kindLabel} · ${Math.max(1, Math.round(selectedAvatar.size / 1024))}KB` : selectedAvatar.message}</p>}<button disabled={uploading || !selectedAvatar?.valid}>{uploading ? "正在上传…" : "上传并应用"}</button></form>{avatar.available && <><p className="fileMeta">{avatar.originalName} · {Math.max(1, Math.round((avatar.size || 0) / 1024))}KB</p><button className="secondary" disabled={uploading} onClick={clearAvatar}>恢复默认形象</button></>}</article></SettingSection>}
      {virtualMode && <SettingSection number="04" title="OBS 与舞台" detail="自动连接；未安装时可一键安装并继续。"><ObsControl onStatusChange={handleObsStatus} /></SettingSection>}
      {virtualMode && <SettingSection number="05" title="摄像头与音频" detail="一键授权并检查会议软件最终读取到的画面和声音。"><div className="settingsPair"><VirtualCameraPreview active={virtualCameraActive} onVerifiedChange={handleCameraVerified} /><AudioRouteControl onReadyChange={handleVirtualAudioReady} /></div></SettingSection>}
      {virtualMode && <SettingSection number="06" title="会议软件确认" detail="在入会预览中完成最后一跳确认。"><MeetingHandoffControl prerequisitesReady={obsConnected && virtualCameraActive && virtualCameraVerified && virtualAudioReady} onConfirmedChange={handleMeetingPreviewConfirmed} /></SettingSection>}
    </section>
  </main>;
}

function SettingSection({ number, title, detail, children }: { number: string; title: string; detail: string; children: React.ReactNode }) { return <div className="settingsSection"><div className="sectionIntro"><span>{number}</span><div><h2>{title}</h2><p>{detail}</p></div></div>{children}</div>; }
function Check({ label, ok, warn, detail }: { label: string; ok: boolean; warn?: boolean; detail: string }) { return <div className="check"><i className={ok ? "ok" : warn ? "warn" : ""}>{ok ? "✓" : "!"}</i><div><strong>{label}</strong><span>{detail}</span></div></div>; }
function transcriptionDetail(diagnostics: Diagnostics) {
  if (diagnostics.transcriptionReady) return diagnostics.transcriptionSource === "management" ? "已由管理端配置" : "本机回退服务可用";
  if (diagnostics.transcriptionConfigured) return "管理端转写暂不可用";
  return "请在管理后台配置语音转写";
}
