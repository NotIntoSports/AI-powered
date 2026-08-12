import { existsSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import type { OwnedProcess } from "./types";

export interface ObsInstallation {
  executablePath: string;
}

export function defaultObsCandidates(environment: NodeJS.ProcessEnv = process.env): string[] {
  return [
    environment.ProgramFiles && path.join(environment.ProgramFiles, "obs-studio", "bin", "64bit", "obs64.exe"),
    environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, "Programs", "obs-studio", "bin", "64bit", "obs64.exe")
  ].filter((candidate): candidate is string => Boolean(candidate));
}

export function detectObsFromCandidates(
  candidates: string[],
  exists: (candidate: string) => boolean = existsSync
): ObsInstallation | null {
  const executablePath = candidates.find(exists);
  return executablePath ? { executablePath } : null;
}

export function detectObs(): ObsInstallation | null {
  return detectObsFromCandidates(defaultObsCandidates());
}

export function startOwnedObs(
  installation: ObsInstallation,
  spawnProcess: (executable: string, args: string[], options: object) => Pick<ChildProcess, "kill"> = spawn
): OwnedProcess {
  const workingDirectory = path.dirname(installation.executablePath);
  const child = spawnProcess(installation.executablePath, ["--minimize-to-tray"], {
    cwd: workingDirectory,
    detached: false,
    stdio: "ignore",
    windowsHide: true
  });
  return { owned: true, child };
}
