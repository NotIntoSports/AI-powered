"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { AudioRouteControl } from "../../features/audio/audio-route-control";
import { describeTtsError } from "../../features/audio/tts-error";
import { MeetingHandoffControl } from "../../features/meeting/meeting-handoff-control";
import { ObsControl } from "../../features/obs/obs-control";
import { VirtualCameraPreview } from "../../features/obs/virtual-camera-preview";
import { getInterviewReadiness } from "../../features/readiness/interview-readiness";
import { getSnapshotReadiness, loadReadinessSnapshot, setReadinessVerification } from "../../features/readiness/readiness-snapshot";
import { AVATAR_ACCEPT, classifyAvatarSelection, type AvatarSelectionResult } from "../../lib/avatar-policy";
import { AppNavigation } from "../../features/settings/app-navigation";
import { ModelSettings } from "../../features/settings/model-settings";

type AvatarMetadata = { available: boolean; kind?: "image" | "video"; originalName?: string; size?: number; version?: string };
type SelectedAvatar = AvatarSelectionResult & { name: string; size: number };
type Diagnostics = { server: boolean; modelConfigured: boolean; stageConnected: boolean; ttsSupported: boolean; voiceCount: number; sapiConfigured: boolean; sapiVoiceCount: number; ttsState: "idle" | "speaking" | "ready" | "error"; ttsError: string; lastSpeechAt: number; mediaReady: boolean; transcriptionConfigured: boolean; transcriptionReady: boolean; transcriptionProvider: "openai" | "whisper-cpp" };
const emptyDiagnostics: Diagnostics = { server: false, modelConfigured: false, stageConnected: false, ttsSupported: false, voiceCount: 0, sapiConfigured: false, sapiVoiceCount: 0, ttsState: "idle", ttsError: "", lastSpeechAt: 0, mediaReady: false, transcriptionConfigured: false, transcriptionReady: false, transcriptionProvider: "openai" };

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
  const [error, setError] = useState("");
  const snapshotLoadedRef = useRef(false);

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
    fetch("/api/avatar", { cache: "no-store" }).then((response) => response.json()).then(setAvatar).catch(() => setError("无法读取数字人素材"));
  }, []);
  useEffect(() => { if (diagnosticsLoaded) setReadinessVerification("speechReady", speechReady); }, [diagnosticsLoaded, speechReady]);

  useEffect(() => {
    let active = true;
    async function refreshDiagnostics() {
      try {
        const [healthResponse, stageResponse] = await Promise.all([fetch("/api/health", { cache: "no-store" }), fetch("/api/stage-status", { cache: "no-store" })]);
        const health = await healthResponse.json(); const stage = await stageResponse.json(); if (!active) return;
        setDiagnostics({ server: healthResponse.ok && health.status === "ok", modelConfigured: Boolean(health.modelConfigured), stageConnected: Boolean(stage.connected), ttsSupported: Boolean(stage.ttsSupported), voiceCount: Number(stage.voiceCount || 0), sapiConfigured: Boolean(health.ttsConfigured), sapiVoiceCount: Number(health.ttsVoiceCount || 0), ttsState: ["idle", "speaking", "ready", "error"].includes(stage.ttsState) ? stage.ttsState : "idle", ttsError: String(stage.ttsError || ""), lastSpeechAt: Number(stage.lastSpeechAt || 0), mediaReady: Boolean(stage.mediaReady), transcriptionConfigured: Boolean(health.transcriptionConfigured), transcriptionReady: Boolean(health.transcriptionReady), transcriptionProvider: health.transcriptionProvider === "whisper-cpp" ? "whisper-cpp" : "openai" });
        setDiagnosticsLoaded(true);
      } catch { if (active) { setDiagnostics((current) => ({ ...current, server: false, stageConnected: false })); setDiagnosticsLoaded(true); } }
    }
    void refreshDiagnostics(); const timer = window.setInterval(refreshDiagnostics, 2_500); return () => { active = false; window.clearInterval(timer); };
  }, []);

  async function uploadAvatar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const file = (form.elements.namedItem("avatar") as HTMLInputElement).files?.[0]; if (!file || !selectedAvatar?.valid) return;
    setUploading(true); setError(""); try { const body = new FormData(); body.append("avatar", file); const response = await fetch("/api/avatar", { method: "POST", body }); const data = await response.json(); if (!response.ok) throw new Error(data.message || "上传失败"); setAvatar(data); setSelectedAvatar(null); form.reset(); } catch (cause) { setError(cause instanceof Error ? cause.message : "上传失败"); } finally { setUploading(false); }
  }
  async function clearAvatar() { setUploading(true); setError(""); try { const response = await fetch("/api/avatar", { method: "DELETE" }); const data = await response.json(); if (!response.ok) throw new Error(data.message || "恢复失败"); setAvatar(data); } catch (cause) { setError(cause instanceof Error ? cause.message : "恢复失败"); } finally { setUploading(false); } }
  async function playTestSpeech() { setTestingSpeech(true); setSpeechTestRequestedAt(0); setError(""); try { const response = await fetch("/api/stage-test-speech", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "你好，这是一段数字人音视频线路测试。" }) }); const data = await response.json(); if (!response.ok) throw new Error(data.message || "测试语音发送失败"); setSpeechTestRequestedAt(Number(data.createdAt || Date.now())); } catch (cause) { setError(cause instanceof Error ? cause.message : "测试语音发送失败"); } finally { setTestingSpeech(false); } }

  const readiness = getInterviewReadiness({ modelConfigured: diagnostics.modelConfigured, stageConnected: diagnostics.stageConnected, mediaReady: diagnostics.mediaReady, speechReady, obsConnected, virtualCameraActive, virtualCameraVerified, virtualAudioReady, meetingPreviewConfirmed });
  return <main className="console settingsPage">
    <header className="topbar"><div><p className="eyebrow">CONFIGURATION</p><h1>设置与检测</h1></div><AppNavigation current="settings" /></header>
    {error && <p className="error" role="alert">{error}</p>}
    <section className={`readinessBanner ${readiness.ready ? "ready" : ""}`}><div><strong>{readiness.ready ? "数字人环境已就绪" : `还有 ${readiness.missing.length} 项需要处理`}</strong><span>{readiness.ready ? "可以返回工作台开始互动。" : readiness.missing.slice(0, 3).map((item) => item.label).join("、")}</span></div><a className="buttonLink" href="/">返回数字人工作台</a></section>
    <section className="settingsGrid">
      <SettingSection number="01" title="系统诊断" detail="先查看当前状态，再处理未通过项目。"><article className="card diagnostics"><div className="checks"><Check label="本地服务" ok={diagnostics.server} detail={diagnostics.server ? "正常" : "不可用"} /><Check label="AI 模型" ok={diagnostics.modelConfigured} detail={diagnostics.modelConfigured ? "已配置" : "尚未配置"} /><Check label="数字人舞台" ok={diagnostics.stageConnected} detail={diagnostics.stageConnected ? "页面在线" : "请打开数字人舞台"} /><Check label="中文语音" ok={speechReady} detail={diagnostics.ttsState === "error" ? describeTtsError(diagnostics.ttsError) : speechReady ? "最近实测播放成功" : diagnostics.sapiConfigured ? `SAPI ${diagnostics.sapiVoiceCount} 个中文声音，等待实测` : "当前舞台不支持 TTS"} /><Check label="画面素材" ok={diagnostics.stageConnected && diagnostics.mediaReady} detail={diagnostics.mediaReady ? "已就绪" : "仍在加载或格式不兼容"} /><Check label="语音转写" ok={diagnostics.transcriptionReady} detail={diagnostics.transcriptionReady ? `${diagnostics.transcriptionProvider} 已就绪` : diagnostics.transcriptionConfigured ? `${diagnostics.transcriptionProvider} 未启动或不可达` : "尚未配置转写服务"} /></div><button disabled={!diagnostics.stageConnected || testingSpeech} onClick={() => void playTestSpeech()}>{testingSpeech ? "正在发送…" : "播放测试语音"}</button></article></SettingSection>
      <SettingSection number="02" title="AI 模型" detail="配置数字人自动回应与对话纪要服务。"><ModelSettings /></SettingSection>
      <SettingSection number="03" title="数字人形象" detail="选择互动中展示的图片或待机视频。"><article className="card mediaSetup"><div className="cardHeading"><h2>当前画面</h2><span>{avatar.available ? "已启用" : "默认形象"}</span></div><div className="mediaPreview">{avatar.available && avatar.kind === "video" && <video src={`/api/avatar/media?v=${avatar.version}`} autoPlay loop muted playsInline />}{avatar.available && avatar.kind === "image" && <img src={`/api/avatar/media?v=${avatar.version}`} alt="当前数字人素材" />}{!avatar.available && <span>当前使用默认数字人</span>}</div><form onSubmit={uploadAvatar}><div className="uploadGuidance"><strong>支持图片 JPG/PNG/WebP，或视频 MP4/WebM；单个文件最大 50MB。</strong><span>推荐 16:9、1280×720；视频将静音循环播放；素材仅保存在本机。</span></div><input name="avatar" type="file" accept={AVATAR_ACCEPT} onChange={(event) => { const file = event.currentTarget.files?.[0]; if (!file) { setSelectedAvatar(null); return; } setSelectedAvatar({ ...classifyAvatarSelection(file), name: file.name, size: file.size }); }} />{selectedAvatar && <p className={`selectedFile ${selectedAvatar.valid ? "" : "invalid"}`} aria-live="polite">{selectedAvatar.valid ? `已选择：${selectedAvatar.name} · ${selectedAvatar.kindLabel} · ${Math.max(1, Math.round(selectedAvatar.size / 1024))}KB` : selectedAvatar.message}</p>}<button disabled={uploading || !selectedAvatar?.valid}>{uploading ? "正在上传…" : "上传并应用"}</button></form>{avatar.available && <><p className="fileMeta">{avatar.originalName} · {Math.max(1, Math.round((avatar.size || 0) / 1024))}KB</p><button className="secondary" disabled={uploading} onClick={clearAvatar}>恢复默认形象</button></>}</article></SettingSection>
      <SettingSection number="04" title="OBS 与舞台" detail="自动连接；未安装时可一键安装并继续。"><ObsControl onStatusChange={handleObsStatus} /></SettingSection>
      <SettingSection number="05" title="摄像头与音频" detail="一键授权并检查会议软件最终读取到的画面和声音。"><div className="settingsPair"><VirtualCameraPreview active={virtualCameraActive} onVerifiedChange={handleCameraVerified} /><AudioRouteControl onReadyChange={handleVirtualAudioReady} /></div></SettingSection>
      <SettingSection number="06" title="会议软件确认" detail="在入会预览中完成最后一跳确认。"><MeetingHandoffControl prerequisitesReady={obsConnected && virtualCameraActive && virtualCameraVerified && virtualAudioReady} onConfirmedChange={handleMeetingPreviewConfirmed} /></SettingSection>
    </section>
  </main>;
}

function SettingSection({ number, title, detail, children }: { number: string; title: string; detail: string; children: React.ReactNode }) { return <div className="settingsSection"><div className="sectionIntro"><span>{number}</span><div><h2>{title}</h2><p>{detail}</p></div></div>{children}</div>; }
function Check({ label, ok, detail }: { label: string; ok: boolean; detail: string }) { return <div className="check"><i className={ok ? "ok" : ""}>{ok ? "✓" : "!"}</i><div><strong>{label}</strong><span>{detail}</span></div></div>; }
