import { existsSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

import type { OwnedProcess } from "./types";

export interface ObsInstallation { executablePath: string; }

export function managedObsExecutable(runtimeRoot: string): string {
  return path.join(runtimeRoot, "bin", "64bit", "obs64.exe");
}

export function detectManagedObs(runtimeRoot: string, exists: (candidate: string) => boolean = existsSync): ObsInstallation | null {
  const executablePath = managedObsExecutable(runtimeRoot);
  return exists(executablePath) ? { executablePath } : null;
}

export function buildManagedObsArgs(port: number, password: string): string[] {
  return [
    "--portable", "--multi", "--only-bundled-plugins", "--disable-updater",
    "--disable-missing-files-check", "--minimize-to-tray", "--websocket_ipv4_only",
    "--websocket_port", String(port), "--websocket_password", password
  ];
}

export function startOwnedObs(
  installation: ObsInstallation,
  websocketPassword: string,
  port = 4455,
  spawnProcess: (executable: string, args: string[], options: object) => Pick<ChildProcess, "kill" | "pid"> = spawn
): OwnedProcess {
  const child = spawnProcess(installation.executablePath, buildManagedObsArgs(port, websocketPassword), {
    cwd: path.dirname(installation.executablePath), detached: false, stdio: "ignore", windowsHide: true
  });
  return { owned: true, child };
}

export function listExternalObsProcesses(managedExecutable: string): number[] {
  if (process.platform !== "win32") return [];
  const escaped = managedExecutable.replaceAll("'", "''");
  const script = `$managed='${escaped}'; Get-CimInstance Win32_Process -Filter \"Name='obs64.exe'\" | Where-Object {$_.ExecutablePath -and $_.ExecutablePath -ne $managed} | Select-Object -ExpandProperty ProcessId | ConvertTo-Json -Compress`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024
  });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout) as number | number[];
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(Number.isInteger);
  } catch { return []; }
}
