import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
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
const { isObsVirtualCameraRegistered, OBS_VIRTUAL_CAMERA_CLSID, registryValueReferencesModule } = windowsInstallModule.exports;

test("classifies prerequisite installation failures without exposing unbounded output", () => {
  assert.equal(classifyPrerequisiteInstallError("PREREQUISITE_UAC_CANCELLED: cancelled").code, "uac-cancelled");
  assert.equal(classifyPrerequisiteInstallError("PREREQUISITE_RESOURCE_MISSING: VirtualAudioDriver.inf").code, "resource-missing");
  assert.equal(classifyPrerequisiteInstallError("PREREQUISITE_SIGNATURE_REJECTED: untrusted catalog").code, "signature-rejected");
  assert.equal(classifyPrerequisiteInstallError("PREREQUISITE_HASH_MISMATCH: obs-virtualcam-module64.dll").code, "hash-mismatch");
  assert.equal(classifyPrerequisiteInstallError("PREREQUISITE_REGISTRATION_FAILED: regsvr32 returned 3").code, "registration-failed");
  assert.equal(classifyPrerequisiteInstallError("PREREQUISITE_INSTALL_FAILED: pnputil failed").code, "install-failed");
  assert.equal(classifyPrerequisiteInstallError("unexpected").code, "unknown");
  assert.equal(classifyPrerequisiteInstallError(`PREREQUISITE_INSTALL_FAILED: ${"x".repeat(800)}`).message.length, 500);
});

test("keeps useful localized pnputil details", () => {
  const result = classifyPrerequisiteInstallError("PREREQUISITE_INSTALL_FAILED: 无法找到包含 空格、中文 和 & 符号的驱动路径");
  assert.equal(result.code, "install-failed");
  assert.match(result.message, /空格、中文/);
});

test("driver installer transports the INF path through immutable encoded JSON instead of command interpolation", async () => {
  const source = await readFile(new URL("../../scripts/install-prerequisite.ps1", import.meta.url), "utf8");
  assert.match(source, /infPath = \$inf\.FullName/);
  assert.match(source, /\/add-driver \$request\.infPath \/install/);
  assert.doesNotMatch(source, /-ArgumentList @\("\/add-driver", \$inf\.FullName/);
  assert.match(source, /FromBase64String\("__REQUEST_JSON__"\)/);
  assert.doesNotMatch(source, /Get-Content -Raw -LiteralPath \$requestPath/);
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
  assert.match(source, /if \(-not \(Test-WorkerRegistryModule \$entry\.view \$entry\.path\)\) \{\s*Invoke-Regsvr32/);
  assert.match(source, /PREREQUISITE_UAC_CANCELLED/);
  assert.match(source, /PREREQUISITE_SIGNATURE_REJECTED/);
  assert.match(source, /PREREQUISITE_HASH_MISMATCH/);
  assert.match(source, /PREREQUISITE_REGISTRATION_FAILED/);
});
