import { spawn, spawnSync } from "node:child_process";
import { detectObs } from "../obs-process";

export type PrerequisiteStatus = { obsInstalled: boolean; virtualAudioInstalled: boolean };

export function getPrerequisiteStatus(): PrerequisiteStatus {
  const devices = spawnSync("pnputil.exe", ["/enum-devices", "/class", "Media"], {
    encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024
  });
  return {
    obsInstalled: detectObs() !== null,
    virtualAudioInstalled: devices.status === 0 && /Virtual Audio (Cable|Device)/i.test(devices.stdout)
  };
}

export function installPrerequisite(options: {
  component: "obs" | "virtual-audio";
  scriptPath: string;
  resourcesDirectory: string;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", options.scriptPath,
      "-Component", options.component,
      "-ResourcesDirectory", options.resourcesDirectory
    ], { windowsHide: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`PREREQUISITE_INSTALL_FAILED_${code}`)));
  });
}
