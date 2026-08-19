import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { classifyPrerequisiteInstallError } from "../desktop/prerequisites/install-error.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(root, "scripts", "install-prerequisite.ps1");
const resourcesDirectory = path.join(root, "resources", "prerequisites");
const logDirectory = path.join(process.env.APPDATA || "", "AI Virtual Assistant", "logs");
const reportPath = path.join(logDirectory, "virtual-audio-smoke.json");

const localRequire = createRequire(import.meta.url);
const windowsInstallSource = readFileSync(path.join(root, "desktop", "prerequisites", "windows-install.ts"), "utf8");
const windowsInstallCompiled = ts.transpileModule(windowsInstallSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText;
const windowsInstallModule = { exports: {} };
new Function("exports", "require", "module", "__filename", "__dirname", windowsInstallCompiled)(
  windowsInstallModule.exports,
  (specifier) => specifier === "./install-error" ? { classifyPrerequisiteInstallError } : localRequire(specifier),
  windowsInstallModule,
  path.join(root, "desktop", "prerequisites", "windows-install.ts"),
  path.join(root, "desktop", "prerequisites")
);
const { installPrerequisite, snapshotVirtualAudioDevices } = windowsInstallModule.exports;

function writeReport(report) {
  mkdirSync(logDirectory, { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
}

if (process.platform !== "win32") {
  throw new Error("virtual audio install smoke requires Windows");
}

const before = snapshotVirtualAudioDevices();
if (before.started) {
  writeReport({ ok: true, reason: "already-started", reportPath, before });
  process.stdout.write("virtual audio smoke passed: CABLE pair or equivalent virtual audio already present\n");
  process.exit(0);
}

const result = await installPrerequisite({
  component: "virtual-audio",
  scriptPath,
  resourcesDirectory,
  logDirectory
});
const after = snapshotVirtualAudioDevices();
const rebootRequired = result?.installed === true && result?.rebootRequired === true;
const report = {
  ok: Boolean(after.started || rebootRequired),
  reportPath,
  result,
  before: { present: before.present, started: before.started, inStore: before.inStore, problemCode: before.problemCode },
  after: {
    present: after.present,
    started: after.started,
    problemCode: after.problemCode,
    inStore: after.inStore,
    byId: after.byId,
    disconnected: after.disconnected
  }
};
writeReport(report);

if (after.started) {
  process.stdout.write("virtual audio smoke passed: CABLE Input and CABLE Output are present\n");
  process.exit(0);
}

if (rebootRequired) {
  process.stdout.write("virtual audio smoke passed: VB-CABLE installed; reboot Windows to load CABLE devices\n");
  process.exit(0);
}

const detail = result?.error?.message || JSON.stringify(result);
if (/uac-cancelled|1223|cancel|\u53d6\u6d88/i.test(`${result?.error?.code || ""} ${detail}`)) {
  process.stderr.write(`virtual audio smoke stopped: administrator approval was cancelled\n${detail}\n`);
  process.exit(2);
}

process.stderr.write(`virtual audio smoke failed: VB-CABLE was not installed\n${detail}\nreport: ${reportPath}\n`);
process.exit(1);
