import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { classifyPrerequisiteInstallError } from "../../desktop/prerequisites/install-error.ts";

const localRequire = createRequire(import.meta.url);
const windowsInstallSource = await readFile(new URL("../../desktop/prerequisites/windows-install.ts", import.meta.url), "utf8");
const windowsInstallCompiled = ts.transpileModule(windowsInstallSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText;
const windowsInstallModule = { exports: {} };
const executeWindowsInstall = new Function("exports", "require", "module", "__filename", "__dirname", windowsInstallCompiled);
executeWindowsInstall(
  windowsInstallModule.exports,
  (specifier) => specifier === "./install-error" ? { classifyPrerequisiteInstallError } : localRequire(specifier),
  windowsInstallModule,
  "windows-install.ts",
  path.dirname(new URL("../../desktop/prerequisites/windows-install.ts", import.meta.url).pathname)
);
const {
  buildWindowsPowerShellEnvironment,
  isObsVirtualCameraRegistered,
  isVirtualAudioDriverStaged,
  isVirtualAudioDeviceInstalled,
  isVirtualAudioDeviceStarted,
  isVbCablePairPresent,
  isVirtualAudioPresentInDriverStore,
  getVirtualAudioProblemCode,
  parseVirtualAudioInstallOutput,
  parsePrerequisiteInstallPayload,
  VIRTUAL_AUDIO_HARDWARE_ID,
  OBS_VIRTUAL_CAMERA_CLSID,
  registryValueReferencesModule
} = windowsInstallModule.exports;

test("classifies prerequisite installation failures without exposing unbounded output", () => {
  assert.equal(classifyPrerequisiteInstallError("PREREQUISITE_UAC_CANCELLED: cancelled").code, "uac-cancelled");
  assert.equal(classifyPrerequisiteInstallError("PREREQUISITE_RESOURCE_MISSING: VirtualAudioDriver.inf").code, "resource-missing");
  assert.equal(classifyPrerequisiteInstallError("PREREQUISITE_SIGNATURE_REJECTED: untrusted catalog").code, "signature-rejected");
  assert.equal(
    classifyPrerequisiteInstallError("PREREQUISITE_SIGNATURE_REJECTED: PREREQUISITE_SIGNATURE_REJECTED: problem 52").message,
    "problem 52"
  );
  assert.equal(classifyPrerequisiteInstallError("PREREQUISITE_HASH_MISMATCH: obs-virtualcam-module64.dll").code, "hash-mismatch");
  assert.equal(classifyPrerequisiteInstallError("PREREQUISITE_REGISTRATION_FAILED: regsvr32 returned 3").code, "registration-failed");
  assert.equal(classifyPrerequisiteInstallError("PREREQUISITE_INSTALL_FAILED: pnputil failed").code, "install-failed");
  assert.equal(classifyPrerequisiteInstallError("PREREQUISITE_MODULE_LOAD_FAILED: security module").code, "module-load-failed");
  assert.equal(classifyPrerequisiteInstallError("unexpected").code, "unknown");
  assert.equal(classifyPrerequisiteInstallError("unexpected").message, "unexpected");
  assert.equal(classifyPrerequisiteInstallError("", 1).message, "exit 1, empty installer output");
  assert.equal(classifyPrerequisiteInstallError(`PREREQUISITE_INSTALL_FAILED: ${"x".repeat(800)}`).message.length, 500);
});

test("keeps useful localized pnputil details", () => {
  const result = classifyPrerequisiteInstallError("PREREQUISITE_INSTALL_FAILED: 无法找到包含 空格、中文 和 & 符号的驱动路径");
  assert.equal(result.code, "install-failed");
  assert.match(result.message, /空格、中文/);
});

test("VB-CABLE installer transports the setup path through immutable encoded JSON instead of command interpolation", async () => {
  const source = await readFile(new URL("../../scripts/install-prerequisite.ps1", import.meta.url), "utf8");
  assert.match(source, /setupPath = \$setup\.FullName/);
  assert.match(source, /VBCABLE_Setup_x64\.exe/);
  assert.match(source, /ArgumentList \$argumentString/);
  assert.match(source, /-i -h/);
  assert.match(source, /WorkingDirectory \$workingDirectory/);
  assert.match(source, /BUREL VINCENT Entrepreneur individuel/);
  assert.match(source, /-Worker/);
  assert.match(source, /FromBase64String\(\$EncodedRequest\)/);
  assert.match(source, /MaxElevatedCommandLength = 24000/);
  assert.doesNotMatch(source, /-EncodedCommand \$encodedScript/);
  assert.doesNotMatch(source, /Get-Content -Raw -LiteralPath \$requestPath/);
  assert.match(source, /ROOT\\VirtualAudioDriver/);
  assert.match(source, /Test-VbCablePairPresent/);
  assert.match(source, /Test-VbCableInDriverStore/);
  assert.match(source, /\$blockPattern/);
  assert.match(source, /Write-InstallerJson/);
  assert.match(source, /-ArgumentList \$argumentString/);
  assert.doesNotMatch(source, /Start-Process -FilePath \$hostExecutable -ArgumentList \$argumentList/);
  assert.doesNotMatch(source, /SetupDiCreateDeviceInfo/);
  assert.doesNotMatch(source, /SignPath Foundation/);
  assert.doesNotMatch(source, /\/add-driver/);
  assert.doesNotMatch(source, /virtual-audio-driver/);
  assert.match(source, /\(\?:Instance ID\|\.\. ID\)/);
  assert.match(source, /\/disconnected/);
});

test("removes PowerShell 7 modules from the Windows PowerShell installer environment", () => {
  const environment = buildWindowsPowerShellEnvironment({
    SystemRoot: String.raw`C:\Windows`,
    PSModulePath: [
      String.raw`C:\Users\tester\Documents\PowerShell\Modules`,
      String.raw`C:\Program Files\PowerShell\7\Modules`,
      String.raw`C:\Program Files\WindowsPowerShell\Modules`,
      String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\Modules`
    ].join(";")
  });
  assert.doesNotMatch(environment.PSModulePath, /\\PowerShell\\7\\Modules/i);
  assert.doesNotMatch(environment.PSModulePath, /Documents\\PowerShell\\Modules/i);
  assert.match(environment.PSModulePath, /Program Files\\WindowsPowerShell\\Modules/i);
  assert.match(environment.PSModulePath, /Windows\\System32\\WindowsPowerShell\\v1\.0\\Modules/i);
});

test("OBS Virtual Camera status requires the exact bundled module in both registry views", () => {
  const obsRoot = String.raw`C:\Program Files\AI Digital Human\resources\prerequisites\obs-portable`;
  const moduleDirectory = path.win32.join(obsRoot, "data", "obs-plugins", "win-dshow");
  const outputFor = (modulePath) => `\n    (Default)    REG_SZ    ${modulePath}\n`;
  const views = [];
  assert.equal(isObsVirtualCameraRegistered(obsRoot, (view) => {
    views.push(view);
    return {
      status: 0,
      stdout: outputFor(path.win32.join(moduleDirectory, `obs-virtualcam-module${view}.dll`))
    };
  }), true);
  assert.deepEqual(views, ["64", "32"]);

  assert.equal(isObsVirtualCameraRegistered(obsRoot, (view) => ({
    status: 0,
    stdout: outputFor(view === "64"
      ? path.win32.join(moduleDirectory, "obs-virtualcam-module64.dll")
      : String.raw`C:\old-preview\obs-virtualcam-module32.dll`)
  })), false);
  assert.equal(isObsVirtualCameraRegistered(obsRoot, (view) => ({
    status: view === "64" ? 0 : 1,
    stdout: view === "64" ? outputFor(path.win32.join(moduleDirectory, "obs-virtualcam-module64.dll")) : ""
  })), false);
});

test("registry output parser is case-insensitive but rejects suffix and command injection text", () => {
  const modulePath = String.raw`C:\OBS Path\obs-virtualcam-module64.dll`;
  assert.equal(registryValueReferencesModule(`(Default) REG_SZ "c:\\obs path\\OBS-VIRTUALCAM-MODULE64.DLL"`, modulePath), true);
  assert.equal(registryValueReferencesModule(`(Default) REG_SZ ${modulePath}.old`, modulePath), false);
  assert.equal(registryValueReferencesModule(`(Default) REG_SZ ${modulePath} & calc.exe`, modulePath), false);
});

test("OBS registration script pins official modules and uses idempotent 32/64 registration", async () => {
  const source = await readFile(new URL("../../scripts/install-prerequisite.ps1", import.meta.url), "utf8");
  assert.match(source, new RegExp(OBS_VIRTUAL_CAMERA_CLSID.replace(/[{}]/g, "\\$&")));
  assert.match(source, /77C6EDF05247C6EAEB8532D99080C4E3F224DD079FDB6180F3480AEF21854271/);
  assert.match(source, /8978F6383AE7105498D9CBB6FFA9F4EC6C0D18657E3999431E2C851CE4C62ED1/);
  assert.match(source, /Assert-ObsModule \$module32 \$ObsVirtualCamera32Sha256/);
  assert.match(source, /Assert-ObsModule \$module64 \$ObsVirtualCamera64Sha256/);
  assert.match(source, /Assert-AuthenticodePublisher \$Path "OBS Project, LLC"/);
  assert.match(source, /RegistryView\]::Registry32/);
  assert.match(source, /RegistryView\]::Registry64/);
  assert.match(source, /SysWOW64\\regsvr32\.exe/);
  assert.match(source, /System32\\regsvr32\.exe/);
  assert.match(source, /Start-Process -FilePath \$executable[\s\S]*-Wait -PassThru/);
  assert.match(source, /\$registration\.ExitCode -ne 0/);
  assert.match(source, /if \(-not \(Test-RegistryModule \$entry\.view \$entry\.path\)\) \{\s*Invoke-Regsvr32/);
  assert.match(source, /PREREQUISITE_UAC_CANCELLED/);
  assert.match(source, /PREREQUISITE_SIGNATURE_REJECTED/);
  assert.match(source, /PREREQUISITE_HASH_MISMATCH/);
  assert.match(source, /PREREQUISITE_REGISTRATION_FAILED/);
  assert.match(source, /PREREQUISITE_MODULE_LOAD_FAILED/);
  assert.match(source, /Import-Module -Name \$modulePath/);
});

test("virtual audio staging looks for VB-CABLE Setup on disk instead of the Windows driver store", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "virtual-audio-staged-"));
  const nested = path.join(root, "vb-cable");
  await mkdir(nested, { recursive: true });
  try {
    assert.equal(isVirtualAudioDriverStaged(root), false);
    await writeFile(path.join(nested, "readme.txt"), "readme", "utf8");
    assert.equal(isVirtualAudioDriverStaged(root), false);
    await writeFile(path.join(nested, "VBCABLE_Setup_x64.exe"), "setup", "utf8");
    assert.equal(isVirtualAudioDriverStaged(root), true);
    assert.equal(isVirtualAudioDriverStaged(path.join(tmpdir(), "missing-prereq")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("virtual audio device and driver-store checks stay independent of staged files", () => {
  const leftoverProblem52 = "Instance ID: ROOT\\VIRTUALAUDIODRIVER\\0000\r\nStatus: Problem\r\nProblem Code: 52\r\n";
  const cablePair = "Device Description: CABLE Input (VB-Audio Virtual Cable)\r\nDevice Description: CABLE Output (VB-Audio Virtual Cable)\r\n";
  const cablePair16Ch = "Device Description: CABLE In 16 Ch (VB-Audio Virtual Cable)\r\nDevice Description: CABLE Output (VB-Audio Virtual Cable)\r\n";
  const cablePairChinese = "Device Description: 扬声器 (VB-Audio Virtual Cable)\r\nDevice Description: 麦克风 (VB-Audio Virtual Cable)\r\n";
  assert.equal(VIRTUAL_AUDIO_HARDWARE_ID, "ROOT\\VirtualAudioDriver");
  assert.equal(isVirtualAudioDeviceInstalled(cablePair), true);
  assert.equal(isVirtualAudioDeviceInstalled(cablePair16Ch), true);
  assert.equal(isVirtualAudioDeviceInstalled(cablePairChinese), true);
  assert.equal(isVirtualAudioDeviceInstalled("Instance ID:                ROOT\\VIRTUALAUDIODRIVER\\0000\r\n"), true);
  assert.equal(isVirtualAudioDeviceInstalled("ToDesk Audio\r\n"), false);
  assert.equal(isVbCablePairPresent(cablePair), true);
  assert.equal(isVbCablePairPresent(cablePair16Ch), true);
  assert.equal(isVbCablePairPresent(cablePairChinese), true);
  assert.equal(isVbCablePairPresent("Device Description: CABLE Output (VB-Audio Virtual Cable)\r\n"), false);
  assert.equal(isVbCablePairPresent("Device Description: CABLE In 16 Ch (VB-Audio Virtual Cable)\r\n"), false);
  assert.equal(isVirtualAudioDeviceStarted(cablePair), true);
  assert.equal(isVirtualAudioDeviceStarted(cablePair16Ch), true);
  assert.equal(isVirtualAudioDeviceStarted(cablePairChinese), true);
  assert.equal(isVirtualAudioDeviceStarted(`${leftoverProblem52}${cablePair}`), true);
  assert.equal(isVirtualAudioDeviceStarted("Instance ID: ROOT\\VIRTUALAUDIODRIVER\\0000\r\nStatus: Started\r\n"), true);
  assert.equal(isVirtualAudioDeviceStarted("实例 ID: ROOT\\VIRTUALAUDIODRIVER\\0000\r\n状态: 已启动\r\n"), true);
  assert.equal(isVirtualAudioDeviceStarted("Instance ID: ROOT\\VIRTUALAUDIODRIVER\\0000\r\nStatus: Disabled\r\n"), false);
  assert.equal(isVirtualAudioDeviceStarted(leftoverProblem52), false);
  assert.equal(isVirtualAudioDeviceStarted(`${leftoverProblem52}Instance ID: ROOT\\MEDIA\\0000\r\nStatus: Started\r\n`), false);
  assert.equal(isVirtualAudioDeviceStarted("Device Description: Voicemeeter Output\r\nDevice Description: Voicemeeter Input\r\n"), true);
  assert.equal(getVirtualAudioProblemCode(leftoverProblem52), "52");
  assert.equal(getVirtualAudioProblemCode("Instance ID: ROOT\\VIRTUALAUDIODRIVER\\0000\r\nStatus: Started\r\n"), "");
  assert.equal(isVirtualAudioPresentInDriverStore("Published Name: oem12.inf\r\nOriginal Name: vbMmeCable64_win10.inf\r\nProvider Name: VB-Audio Software"), true);
  assert.equal(isVirtualAudioPresentInDriverStore("Published Name: oem12.inf\r\nOriginal Name: VirtualAudioDriver.inf\r\nProvider Name: MikeTheTech"), false);
  assert.equal(isVirtualAudioPresentInDriverStore("oem1.inf  Microsoft"), false);
  assert.equal(parseVirtualAudioInstallOutput('{"installed":true,"rebootRequired":true,"output":"ok"}\n').rebootRequired, true);
  assert.equal(parseVirtualAudioInstallOutput('{"installed":true,"rebootRequired":false}\n').rebootRequired, false);
  assert.equal(parseVirtualAudioInstallOutput("not json").rebootRequired, false);
  assert.equal(parsePrerequisiteInstallPayload('{"installed":false,"errorCode":"PREREQUISITE_INSTALL_FAILED","detail":"conflict","rebootRequired":false}\n').errorCode, "PREREQUISITE_INSTALL_FAILED");
  assert.equal(parsePrerequisiteInstallPayload('{"installed":false,"errorCode":"PREREQUISITE_INSTALL_FAILED","detail":"conflict","rebootRequired":false}\n').detail, "conflict");
  assert.equal(parsePrerequisiteInstallPayload("not json"), null);
});

test("IPC reads prerequisite status from the project resources directory", async () => {
  const ipc = await readFile(new URL("../../desktop/ipc.ts", import.meta.url), "utf8");
  const fetchScript = await readFile(new URL("../../scripts/fetch-prerequisites.ps1", import.meta.url), "utf8");
  const windowsInstall = await readFile(new URL("../../desktop/prerequisites/windows-install.ts", import.meta.url), "utf8");
  assert.match(ipc, /getPrerequisiteStatus\(installResources\.directory/);
  assert.match(ipc, /desktop:ensure-virtual-audio/);
  assert.match(ipc, /ensureVirtualAudioResources/);
  assert.match(windowsInstall, /"-Component", "virtual-audio"/);
  assert.match(windowsInstall, /isVirtualAudioPresentInDriverStore/);
  assert.match(windowsInstall, /parsePrerequisiteInstallPayload/);
  assert.match(windowsInstall, /appendPrerequisiteInstallLog/);
  assert.match(windowsInstall, /logDirectory/);
  assert.match(ipc, /logDirectory/);
  assert.match(windowsInstall, /isVirtualAudioDeviceStarted/);
  assert.match(windowsInstall, /getVirtualAudioProblemCode/);
  assert.doesNotMatch(windowsInstall, /problemCode === "52"/);
  assert.match(windowsInstall, /virtualAudioPresentInDriverStore/);
  assert.match(windowsInstall, /AudioEndpoint/);
  assert.match(windowsInstall, /vb-cable/);
  assert.match(windowsInstall, /VBCABLE_Setup_x64\.exe/i);
  assert.doesNotMatch(
    windowsInstall,
    /rebootRequired = options.component === "virtual-audio"\s*&&\s*!status.virtualAudioInstalled\s*&&\s*drivers.status === 0/
  );
  assert.match(fetchScript, /ValidateSet\("all", "obs", "virtual-audio"\)/);
  assert.match(fetchScript, /BUREL VINCENT Entrepreneur individuel/);
  assert.match(fetchScript, /VBCABLE_Driver_Pack45\.zip/);
  assert.match(fetchScript, /\$Destination/);
});

test("classifies virtual audio download failures", () => {
  assert.equal(classifyPrerequisiteInstallError("PREREQUISITE_DOWNLOAD_FAILED: VBCABLE_Driver_Pack45.zip").code, "download-failed");
});
