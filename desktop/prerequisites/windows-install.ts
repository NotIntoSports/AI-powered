import { spawn, spawnSync } from "node:child_process";
import { detectObs } from "../obs-process";
import type { PrerequisiteInstallResult } from "../types";
import { classifyPrerequisiteInstallError } from "./install-error";

export type PrerequisiteStatus = { obsInstalled: boolean; virtualAudioInstalled: boolean; virtualAudioDriverStaged: boolean };

function runPnpUtil(args: string[]) {
  return spawnSync("pnputil.exe", args, {
    encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024
  });
}

export function getPrerequisiteStatus(): PrerequisiteStatus {
  const devices = runPnpUtil(["/enum-devices", "/class", "Media"]);
  const drivers = runPnpUtil(["/enum-drivers"]);
  return {
    obsInstalled: detectObs() !== null,
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
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
      const status = getPrerequisiteStatus();
      const rebootRequired = options.component === "virtual-audio" && !status.virtualAudioInstalled && status.virtualAudioDriverStaged;
      resolve({ installed: true, rebootRequired });
    });
  });
}
