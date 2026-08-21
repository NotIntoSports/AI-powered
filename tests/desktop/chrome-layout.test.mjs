import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("workspace chrome puts login bottom-left and upload top-right", async () => {
  const page = await readFile(new URL("../../app/page.tsx", import.meta.url), "utf8");
  const chrome = await readFile(new URL("../../features/settings/app-chrome.tsx", import.meta.url), "utf8");
  const account = await readFile(new URL("../../features/settings/user-account-menu.tsx", import.meta.url), "utf8");
  const upload = await readFile(new URL("../../features/settings/upload-materials-dock.tsx", import.meta.url), "utf8");
  const nav = await readFile(new URL("../../features/settings/app-navigation.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../../app/styles.css", import.meta.url), "utf8");

  assert.match(page, /AppChrome/);
  assert.match(page, /upload=\{\{/);
  assert.doesNotMatch(page, /resumeSummary/);
  assert.doesNotMatch(page, /<ResumeUpload/);
  assert.doesNotMatch(page, /AppNavigation/);
  assert.match(page, /UploadMaterialsDock|upload=\{\{/);

  assert.match(chrome, /UserAccountMenu/);
  assert.match(chrome, /UploadMaterialsDock/);
  assert.match(account, /accountDock/);
  assert.match(account, /href="\/login"/);
  assert.match(account, /href="\/settings"/);
  assert.match(account, /href="\/records"/);
  assert.match(upload, /uploadDock/);
  assert.match(upload, /上传资料/);
  assert.match(upload, /ResumeUpload/);

  assert.match(nav, /appNavMinimal/);
  assert.doesNotMatch(nav, /href="\/settings"/);
  assert.doesNotMatch(nav, /href="\/login"/);

  assert.match(styles, /\.accountDock\s*\{[^}]*position:\s*fixed/s);
  assert.match(styles, /\.accountDock\s*\{[^}]*bottom:\s*16px/s);
  assert.match(styles, /\.uploadDockAnchor\s*\{[^}]*position:\s*fixed/s);
  assert.match(styles, /\.uploadDockAnchor\s*\{[^}]*right:\s*16px/s);
});

test("workspace keeps heavy meeting access off the main page but embeds the auto bridge card", async () => {
  const page = await readFile(new URL("../../app/page.tsx", import.meta.url), "utf8");
  const settings = await readFile(new URL("../../app/settings/page.tsx", import.meta.url), "utf8");
  const card = await readFile(new URL("../../features/meeting/meeting-access-card.tsx", import.meta.url), "utf8");
  const handoff = await readFile(new URL("../../features/meeting/meeting-handoff-control.tsx", import.meta.url), "utf8");
  const snapshot = await readFile(new URL("../../features/readiness/readiness-snapshot.ts", import.meta.url), "utf8");
  const intervention = await readFile(new URL("../../features/intervention/intervention-controls.tsx", import.meta.url), "utf8");
  const monitor = await readFile(new URL("../../features/audio/remote-monitor.ts", import.meta.url), "utf8");

  assert.doesNotMatch(page, /MeetingAccessCard/);
  assert.doesNotMatch(page, /RtcBridgeControl/);
  assert.match(page, /MeetingBridgeCard/);
  assert.doesNotMatch(page, /readinessBanner/);
  assert.match(page, /IntegrationAlerts missing=\{readiness\.missing\}/);
  assert.match(page, /虚拟声卡可选/);
  assert.match(page, /attachRemoteMonitor/);
  const alerts = await readFile(new URL("../../features/meeting/integration-alerts.tsx", import.meta.url), "utf8");
  assert.match(alerts, /workspaceToasts/);
  assert.match(alerts, /workspaceToastClose/);
  const styles = await readFile(new URL("../../app/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.workspaceToasts\s*\{[^}]*position:\s*fixed/s);
  assert.match(settings, /RtcBridgeControl/);
  assert.match(settings, /AudioRouteControl onReadyChange=\{handleVirtualAudioReady\}/);
  assert.match(settings, /MeetingHandoffControl/);
  assert.match(settings, /id="settings-output-mode"/);
  assert.match(settings, /virtualMode \? <VirtualCameraPreview/);
  assert.doesNotMatch(settings, /virtualMode && <SettingSection number="06"/);
  assert.doesNotMatch(settings, /virtualMode && <SettingSection number="07"/);
  assert.match(card, /AudioRouteControl/);
  assert.match(card, /MeetingHandoffControl/);
  assert.match(handoff, /outputMode/);
  assert.match(handoff, /自己的真实摄像头/);
  assert.match(handoff, /OBS Virtual Camera/);
  assert.match(snapshot, /virtualCameraActive.*virtualCameraVerified/s);
  assert.match(snapshot, /!next\.virtualAudioReady/);
  assert.doesNotMatch(snapshot, /delete next\.virtualAudioReady; delete next\.meetingPreviewConfirmed/);
  assert.match(intervention, /本机听到对方说话/);
  assert.match(monitor, /parseRemoteMonitorEnabled/);
  assert.match(monitor, /ai-remote-monitor-enabled/);
});
