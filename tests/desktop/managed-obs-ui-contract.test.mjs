import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function importTypeScriptModule(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

test("managed OBS failures always become actionable Chinese messages", async () => {
  const { formatManagedObsFailure, formatPrerequisiteInstallError, managedObsBadgeLabel } =
    await importTypeScriptModule("../../features/obs/managed-obs-state.ts");

  const failures = [
    ["configuration", "OBS_CONFIG_WRITE_FAILED", "写入"],
    ["configuration", "OBS_SECURE_STORAGE_UNAVAILABLE", "安全存储"],
    ["configuration", "OBS_SECURE_STORAGE_FAILED", "安全存储"],
    ["process", "OBS_SPAWN_FAILED", "启动失败"],
    ["process", "OBS_PROCESS_EXITED", "启动过程中退出"],
    ["process", "OBS_PROCESS_TERMINATION_FAILED", "安全停止"],
    ["port", "OBS_PORT_IN_USE", "端口 4455"],
    ["port", "OBS_PORT_NOT_READY", "30 秒"],
    ["auth", "OBS_AUTH_FAILED", "安全认证"],
    ["auth", "OBS_CONNECTION_LOST", "连接已断开"],
    ["scene", "OBS_SCENE_CONFIG_FAILED", "场景配置"],
    ["virtual-camera", "OBS_VIRTUAL_CAMERA_NOT_REGISTERED", "管理员授权"],
    ["virtual-camera", "OBS_VIRTUAL_CAMERA_FAILED", "无法启动"]
  ];
  for (const [stage, code, expected] of failures) {
    const message = formatManagedObsFailure({ stage, code });
    assert.match(message, new RegExp(expected));
    assert.notEqual(message.trim().toLowerCase(), "failed");
  }

  assert.match(
    formatManagedObsFailure({ stage: "scene", code: "OBS_NEW_FAILURE" }),
    /场景配置.*OBS_NEW_FAILURE/
  );
  assert.doesNotMatch(
    formatManagedObsFailure({ stage: "scene", code: "failed" }),
    /failed/i
  );
  assert.match(formatPrerequisiteInstallError({ code: "uac-cancelled" }), /管理员授权已取消/);
  assert.match(formatPrerequisiteInstallError({ code: "signature-rejected" }), /数字签名/);
  assert.match(formatPrerequisiteInstallError({ code: "module-load-failed" }), /PowerShell/);
  assert.match(formatPrerequisiteInstallError({ code: "registration-failed" }), /注册/);
  assert.equal(managedObsBadgeLabel("idle"), "未连接");
  assert.equal(managedObsBadgeLabel("starting"), "正在启动");
  assert.equal(managedObsBadgeLabel("connecting"), "正在连接");
  assert.equal(managedObsBadgeLabel("ready", "5.6.2"), "已连接 5.6.2");
  assert.equal(managedObsBadgeLabel("failed"), "启动失败");
  assert.equal(managedObsBadgeLabel("needs-authorization"), "需要授权");
});

test("renderer controls managed OBS only through the restricted desktop bridge", async () => {
  const control = await readFile(new URL("../../features/obs/obs-control.tsx", import.meta.url), "utf8");
  const state = await readFile(new URL("../../features/obs/managed-obs-state.ts", import.meta.url), "utf8");
  const setup = await readFile(new URL("../../features/desktop/prerequisite-setup.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(control, /obs-websocket-js|OBSWebSocket|\.connect\s*\(/);
  assert.doesNotMatch(control, /\bpassword(?:Ref)?\b|targetUrl|stageUrl/);
  assert.doesNotMatch(state, /\bpassword\b|\bstageUrl\b|\burl\s*:/);
  for (const method of [
    "ensureManagedObs",
    "getManagedObsState",
    "setManagedObsVirtualCamera",
    "setManagedObsInterventionRouting",
    "stopManagedObs",
    "resetManagedObsConfig"
  ]) assert.match(control, new RegExp(`\\.${method}\\(`));

  assert.match(control, /data-state=\{badge\}/);
  assert.match(control, /needs-authorization/);
  assert.match(control, /installPrerequisite\("obs"\)/);
  assert.match(setup, /obsBundled/);
  assert.match(setup, /virtualCameraRegistered/);
  assert.match(setup, /install\("obs"\)/);
});
