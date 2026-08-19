import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EnsureVirtualAudioResult, PrerequisiteInstallResult, PrerequisiteStatus } from "../types";
import { classifyPrerequisiteInstallError } from "./install-error";

export const OBS_VIRTUAL_CAMERA_CLSID = "{A3FCE0F5-3493-419F-958A-ABA1250EC20B}";

type CommandResult = { status: number | null; stdout: string };
type RegistryQuery = (view: "32" | "64") => CommandResult;

export function buildWindowsPowerShellEnvironment(
  baseEnvironment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const systemRoot = baseEnvironment.SystemRoot || baseEnvironment.WINDIR || "C:\\Windows";
  const compatibleModulePaths = (baseEnvironment.PSModulePath ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => /(?:^|\\)WindowsPowerShell(?:\\|$)/i.test(entry));
  const builtInModulePath = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "Modules"
  );
  if (!compatibleModulePaths.some((entry) => path.win32.normalize(entry).toLowerCase() === builtInModulePath.toLowerCase())) {
    compatibleModulePaths.push(builtInModulePath);
  }
  return { ...baseEnvironment, PSModulePath: compatibleModulePaths.join(path.delimiter) };
}

function runPnpUtil(args: string[]) {
  const argList = args.map((arg) => `'${arg.replace(/'/g, "''")}'`).join(" ");
  const command = [
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
    "$OutputEncoding = [Console]::OutputEncoding",
    "$pnputil = Join-Path $env:SystemRoot 'System32\\pnputil.exe'",
    `& $pnputil ${argList} | Out-String`
  ].join("; ");
  return spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    env: buildWindowsPowerShellEnvironment()
  });
}

function resolveObsRoot(resourcesDirectory: string): string {
  const candidates = [
    path.join(resourcesDirectory, "prerequisites", "obs-portable"),
    path.join(resourcesDirectory, "obs-portable"),
    path.join(process.cwd(), "resources", "prerequisites", "obs-portable")
  ];
  return candidates.find((candidate) => existsSync(path.join(candidate, "bin", "64bit", "obs64.exe"))) ?? candidates[0];
}

function queryVirtualCameraRegistration(view: "32" | "64"): CommandResult {
  return spawnSync("reg.exe", [
    "query",
    `HKLM\\SOFTWARE\\Classes\\CLSID\\${OBS_VIRTUAL_CAMERA_CLSID}\\InprocServer32`,
    "/ve",
    `/reg:${view}`
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 });
}

function normalizeWindowsPath(value: string): string {
  return path.win32.normalize(value.trim().replace(/^"(.*)"$/, "$1")).toLowerCase();
}

export function registryValueReferencesModule(output: string, modulePath: string): boolean {
  const expected = normalizeWindowsPath(modulePath);
  return output.split(/\r?\n/).some((line) => {
    const typeOffset = line.toUpperCase().indexOf("REG_SZ");
    if (typeOffset < 0) return false;
    return normalizeWindowsPath(line.slice(typeOffset + "REG_SZ".length)) === expected;
  });
}

export function isObsVirtualCameraRegistered(obsRoot: string, query: RegistryQuery = queryVirtualCameraRegistration): boolean {
  const moduleDirectory = path.join(obsRoot, "data", "obs-plugins", "win-dshow");
  const registrations = [
    { view: "64" as const, modulePath: path.join(moduleDirectory, "obs-virtualcam-module64.dll") },
    { view: "32" as const, modulePath: path.join(moduleDirectory, "obs-virtualcam-module32.dll") }
  ];
  return registrations.every(({ view, modulePath }) => {
    const result = query(view);
    return result.status === 0 && registryValueReferencesModule(result.stdout, modulePath);
  });
}

const VB_CABLE_SETUP = "vbcable_setup_x64.exe";
const VB_CABLE_DIRECTORY = "vb-cable";

function findFileByName(root: string, lowerName: string): string | null {
  if (!existsSync(root)) return null;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase() === lowerName) return fullPath;
    }
  }
  return null;
}

export function findVirtualAudioSetup(resourcesDirectory: string): string | null {
  return findFileByName(path.join(resourcesDirectory, VB_CABLE_DIRECTORY), VB_CABLE_SETUP);
}

export function isVirtualAudioDriverStaged(
  resourcesDirectory: string,
  extraResourceDirectories: string[] = []
): boolean {
  return [resourcesDirectory, ...extraResourceDirectories].some((directory) => findVirtualAudioSetup(directory) !== null);
}

export const VIRTUAL_AUDIO_HARDWARE_ID = "ROOT\\VirtualAudioDriver";
export const VB_CABLE_PUBLISHER = "BUREL VINCENT Entrepreneur individuel";

export function isVbCablePairPresent(output: string): boolean {
  const recording = /\bCABLE Output\b/i.test(output) || /麦克风\s*\([^)]*VB-Audio[^)]*\)/i.test(output);
  const playback = /\bCABLE\s+In(?:put)?\b/i.test(output) || /扬声器\s*\([^)]*VB-Audio[^)]*\)/i.test(output);
  return recording && playback;
}

export function isVoicemeeterPairPresent(output: string): boolean {
  return /Voicemeeter(?:\s+(?:AUX|VAIO3))?\s+Output/i.test(output)
    && /Voicemeeter(?:\s+(?:AUX|VAIO3))?\s+Input/i.test(output);
}

export function isVirtualAudioDeviceInstalled(output: string): boolean {
  return isVbCablePairPresent(output)
    || isVoicemeeterPairPresent(output)
    || /ROOT\\VIRTUALAUDIODRIVER|Virtual Audio (Cable|Device|Driver)|Virtual Mic Driver/i.test(output);
}

export function isVirtualAudioDeviceStarted(output: string): boolean {
  if (isVbCablePairPresent(output) || isVoicemeeterPairPresent(output)) return true;
  const blockPattern = /(?:Instance ID|实例 ID):\s*(ROOT\\VIRTUALAUDIODRIVER\\[^\r\n]+)(.*?)(?=(?:Instance ID|实例 ID):|$)/gis;
  for (const match of output.matchAll(blockPattern)) {
    const body = match[2] || "";
    if (/(?:Status|状态):\s*Problem/i.test(body)) continue;
    if (/(?:Status|状态):\s*(?:Started\b|已启动)/i.test(body)) return true;
  }
  return false;
}

export function getVirtualAudioProblemCode(output: string): string {
  const blockPattern = /(?:Instance ID|实例 ID):\s*(ROOT\\VIRTUALAUDIODRIVER\\[^\r\n]+)(.*?)(?=(?:Instance ID|实例 ID):|$)/gis;
  for (const match of output.matchAll(blockPattern)) {
    const problem = (match[2] || "").match(/Problem Code:\s*(\d+)/i);
    if (problem?.[1]) return problem[1];
  }
  return "";
}

export function isVirtualAudioPresentInDriverStore(output: string): boolean {
  return /vbaudio_cable|vbMmeCable/i.test(output);
}

export function parsePrerequisiteInstallPayload(stdout: string): {
  installed?: boolean;
  rebootRequired: boolean;
  errorCode?: string;
  detail?: string;
} | null {
  const lines = stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(line) as {
        installed?: unknown;
        rebootRequired?: unknown;
        errorCode?: unknown;
        detail?: unknown;
        output?: unknown;
      };
      return {
        installed: typeof parsed.installed === "boolean" ? parsed.installed : undefined,
        rebootRequired: parsed.rebootRequired === true,
        errorCode: typeof parsed.errorCode === "string" && parsed.errorCode ? parsed.errorCode : undefined,
        detail: typeof parsed.detail === "string"
          ? parsed.detail
          : typeof parsed.output === "string" ? parsed.output : undefined
      };
    } catch {
      continue;
    }
  }
  return null;
}

export function parseVirtualAudioInstallOutput(stdout: string): { rebootRequired: boolean } {
  return { rebootRequired: parsePrerequisiteInstallPayload(stdout)?.rebootRequired === true };
}

export function collectVirtualAudioDeviceOutput(): string {
  return ["Media", "AudioEndpoint"]
    .map((deviceClass) => {
      const result = runPnpUtil(["/enum-devices", "/class", deviceClass]);
      return result.status === 0 ? result.stdout : "";
    })
    .join("\n");
}

export function snapshotVirtualAudioDevices() {
  const devices = collectVirtualAudioDeviceOutput();
  const byId = runPnpUtil(["/enum-devices", "/deviceid", VIRTUAL_AUDIO_HARDWARE_ID]);
  const disconnected = runPnpUtil(["/enum-devices", "/disconnected", "/deviceid", VIRTUAL_AUDIO_HARDWARE_ID]);
  const drivers = runPnpUtil(["/enum-drivers"]);
  const combined = [devices, byId.stdout, disconnected.stdout].join("\n");
  return {
    present: isVirtualAudioDeviceInstalled(combined),
    started: isVirtualAudioDeviceStarted(combined),
    problemCode: getVirtualAudioProblemCode(combined),
    inStore: drivers.status === 0 && isVirtualAudioPresentInDriverStore(drivers.stdout || ""),
    byId: byId.stdout || "",
    disconnected: disconnected.stdout || "",
    devices
  };
}

export function resolveVirtualAudioResourcesDirectory(
  resourcesDirectory: string,
  extraResourceDirectories: string[] = []
): string {
  return [resourcesDirectory, ...extraResourceDirectories].find((directory) => findVirtualAudioSetup(directory))
    ?? resourcesDirectory;
}

function appendPrerequisiteInstallLog(logDirectory: string | undefined, message: string) {
  if (!logDirectory) return;
  try {
    mkdirSync(logDirectory, { recursive: true });
    appendFileSync(path.join(logDirectory, "prerequisite-install.log"), `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    return;
  }
}

function isDirectoryWritable(directory: string): boolean {
  try {
    mkdirSync(directory, { recursive: true });
    const probe = path.join(directory, `.write-probe-${process.pid}`);
    writeFileSync(probe, "ok");
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

export function getPrerequisiteStatus(
  resourcesDirectory = process.resourcesPath,
  extraResourceDirectories: string[] = []
): PrerequisiteStatus {
  const obsRoot = resolveObsRoot(resourcesDirectory);
  const obsExecutable = path.join(obsRoot, "bin", "64bit", "obs64.exe");
  const virtualCameraDirectory = path.join(obsRoot, "data", "obs-plugins", "win-dshow");
  const obsBundled = [
    obsExecutable,
    path.join(virtualCameraDirectory, "obs-virtualcam-module64.dll"),
    path.join(virtualCameraDirectory, "obs-virtualcam-module32.dll")
  ].every((filePath) => existsSync(filePath));
  const snapshot = snapshotVirtualAudioDevices();
  return {
    obsBundled,
    virtualCameraRegistered: obsBundled && isObsVirtualCameraRegistered(obsRoot),
    virtualAudioInstalled: snapshot.started,
    virtualAudioDriverStaged: isVirtualAudioDriverStaged(resourcesDirectory, extraResourceDirectories),
    virtualAudioPresentInDriverStore: snapshot.inStore
  };
}

export function installPrerequisite(options: {
  component: "obs" | "virtual-audio";
  scriptPath: string;
  resourcesDirectory: string;
  extraResourceDirectories?: string[];
  logDirectory?: string;
}): Promise<PrerequisiteInstallResult> {
  const extraResourceDirectories = options.extraResourceDirectories ?? [];
  const resourcesDirectory = options.component === "virtual-audio"
    ? resolveVirtualAudioResourcesDirectory(options.resourcesDirectory, extraResourceDirectories)
    : options.resourcesDirectory;
  appendPrerequisiteInstallLog(
    options.logDirectory,
    `install ${options.component} script=${options.scriptPath} resources=${resourcesDirectory}`
  );
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (result: PrerequisiteInstallResult) => {
      if (settled) return;
      settled = true;
      const summary = result.installed
        ? `installed rebootRequired=${result.rebootRequired}`
        : `failed code=${result.error.code} ${result.error.message}`;
      appendPrerequisiteInstallLog(options.logDirectory, `${summary}\nstdout=${stdout.slice(0, 4000)}\nstderr=${stderr.slice(0, 4000)}`);
      resolve(result);
    };
    const child = spawn("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", options.scriptPath,
      "-Component", options.component,
      "-ResourcesDirectory", resourcesDirectory
    ], {
      env: buildWindowsPowerShellEnvironment(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => {
      finish({
        installed: false,
        error: classifyPrerequisiteInstallError(error instanceof Error ? error.message : String(error), 1)
      });
    });
    child.once("exit", (code) => {
      const payload = parsePrerequisiteInstallPayload(stdout);
      const raw = `${stderr}\n${stdout}`.trim();
      if (code !== 0 || payload?.installed === false) {
        const classified = payload?.errorCode
          ? classifyPrerequisiteInstallError(`${payload.errorCode}: ${payload.detail || raw}`, code)
          : classifyPrerequisiteInstallError(raw, code);
        finish({ installed: false, error: classified });
        return;
      }
      const status = getPrerequisiteStatus(resourcesDirectory, extraResourceDirectories);
      if (options.component === "obs" && !status.virtualCameraRegistered) {
        finish({
          installed: false,
          error: { code: "registration-failed", message: "Windows did not retain both OBS Virtual Camera registrations" }
        });
        return;
      }
      if (options.component === "virtual-audio" && !status.virtualAudioInstalled) {
        const rebootRequired = payload?.rebootRequired === true || parseVirtualAudioInstallOutput(stdout).rebootRequired;
        if (rebootRequired) {
          finish({ installed: true, rebootRequired: true });
          return;
        }
        finish({
          installed: false,
          error: classifyPrerequisiteInstallError(
            payload?.detail
              ? `PREREQUISITE_INSTALL_FAILED: ${payload.detail}`
              : raw || "PREREQUISITE_INSTALL_FAILED: VB-CABLE was not installed",
            code
          )
        });
        return;
      }
      const rebootRequired = options.component === "virtual-audio"
        && (payload?.rebootRequired === true || parseVirtualAudioInstallOutput(stdout).rebootRequired)
        && !status.virtualAudioInstalled;
      finish({ installed: true, rebootRequired });
    });
  });
}

export function ensureVirtualAudioResources(options: {
  fetchScriptPath: string;
  resourcesDirectory: string;
  userDataDirectory: string;
}): Promise<EnsureVirtualAudioResult> {
  const extra = [options.userDataDirectory];
  if (isVirtualAudioDriverStaged(options.resourcesDirectory, extra)) {
    return Promise.resolve({ staged: true });
  }
  if (!existsSync(options.fetchScriptPath)) {
    return Promise.resolve({
      staged: false,
      error: { code: "resource-missing", message: "fetch-prerequisites.ps1 is missing" }
    });
  }
  const destination = isDirectoryWritable(options.resourcesDirectory)
    ? options.resourcesDirectory
    : options.userDataDirectory;
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", options.fetchScriptPath,
      "-Component", "virtual-audio",
      "-Destination", destination
    ], {
      env: buildWindowsPowerShellEnvironment(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (isVirtualAudioDriverStaged(options.resourcesDirectory, extra)) {
        resolve({ staged: true });
        return;
      }
      const classified = classifyPrerequisiteInstallError(`${stderr}\n${stdout}`);
      resolve({
        staged: false,
        error: {
          code: classified.code === "unknown" && code !== 0 ? "download-failed" : classified.code,
          message: classified.message
        }
      });
    });
  });
}
