import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { PrerequisiteInstallResult, PrerequisiteStatus } from "../types";
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
  return spawnSync("pnputil.exe", args, {
    encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024
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

export function getPrerequisiteStatus(resourcesDirectory = process.resourcesPath): PrerequisiteStatus {
  const obsRoot = resolveObsRoot(resourcesDirectory);
  const obsExecutable = path.join(obsRoot, "bin", "64bit", "obs64.exe");
  const virtualCameraDirectory = path.join(obsRoot, "data", "obs-plugins", "win-dshow");
  const obsBundled = [
    obsExecutable,
    path.join(virtualCameraDirectory, "obs-virtualcam-module64.dll"),
    path.join(virtualCameraDirectory, "obs-virtualcam-module32.dll")
  ].every((filePath) => existsSync(filePath));
  const devices = runPnpUtil(["/enum-devices", "/class", "Media"]);
  const drivers = runPnpUtil(["/enum-drivers"]);
  return {
    obsBundled,
    virtualCameraRegistered: obsBundled && isObsVirtualCameraRegistered(obsRoot),
    virtualAudioInstalled: devices.status === 0 && /Virtual Audio (Cable|Device|Driver)|Virtual Mic Driver/i.test(devices.stdout),
    virtualAudioDriverStaged: drivers.status === 0 && /MikeTheTech|VirtualAudioDriver/i.test(drivers.stdout)
  };
}

export function installPrerequisite(options: {
  component: "obs" | "virtual-audio";
  scriptPath: string;
  resourcesDirectory: string;
}): Promise<PrerequisiteInstallResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", options.scriptPath,
      "-Component", options.component,
      "-ResourcesDirectory", options.resourcesDirectory
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
      if (code !== 0) {
        resolve({ installed: false, error: classifyPrerequisiteInstallError(`${stderr}\n${stdout}`) });
        return;
      }
      const status = getPrerequisiteStatus(options.resourcesDirectory);
      if (options.component === "obs" && !status.virtualCameraRegistered) {
        resolve({
          installed: false,
          error: { code: "registration-failed", message: "Windows did not retain both OBS Virtual Camera registrations" }
        });
        return;
      }
      const rebootRequired = options.component === "virtual-audio" && !status.virtualAudioInstalled && status.virtualAudioDriverStaged;
      resolve({ installed: true, rebootRequired });
    });
  });
}
