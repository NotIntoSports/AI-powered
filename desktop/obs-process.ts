import { existsSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";

export interface ObsInstallation { executablePath: string; }
export interface ManagedObsOwnedProcess { owned: true; child: ChildProcess; }

export function managedObsExecutable(runtimeRoot: string): string {
  return path.join(runtimeRoot, "bin", "64bit", "obs64.exe");
}

export function detectManagedObs(runtimeRoot: string, exists: (candidate: string) => boolean = existsSync): ObsInstallation | null {
  const executablePath = managedObsExecutable(runtimeRoot);
  return exists(executablePath) ? { executablePath } : null;
}

export function buildManagedObsArgs(): string[] {
  return [
    "--portable", "--multi", "--only-bundled-plugins", "--disable-updater",
    "--disable-missing-files-check", "--minimize-to-tray", "--websocket_ipv4_only"
  ];
}

export function startOwnedObs(
  installation: ObsInstallation,
  spawnProcess: (executable: string, args: string[], options: object) => ChildProcess = spawn
): ManagedObsOwnedProcess {
  const child = spawnProcess(installation.executablePath, buildManagedObsArgs(), {
    cwd: path.dirname(installation.executablePath), detached: false, stdio: "ignore", windowsHide: true
  });
  return { owned: true, child };
}

type SpawnSyncProcess = (
  executable: string,
  args: string[],
  options: { encoding: "utf8"; windowsHide: boolean; maxBuffer: number }
) => Pick<SpawnSyncReturns<string>, "status" | "stdout">;

function listObsProcessesByPath(
  managedExecutable: string,
  matchesManaged: boolean,
  spawnCommand: SpawnSyncProcess = spawnSync
): number[] {
  if (process.platform !== "win32") return [];
  const escaped = managedExecutable.replaceAll("'", "''");
  const script = `$managed=[IO.Path]::GetFullPath('${escaped}'); Get-CimInstance Win32_Process -Filter \"Name='obs64.exe'\" | Where-Object {$_.ExecutablePath -and [string]::Equals([IO.Path]::GetFullPath($_.ExecutablePath),$managed,[StringComparison]::OrdinalIgnoreCase) ${matchesManaged ? "" : "-eq $false"}} | Select-Object -ExpandProperty ProcessId | ConvertTo-Json -Compress`;
  const result = spawnCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024
  });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout) as number | number[];
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(Number.isInteger);
  } catch { return []; }
}

export function listExternalObsProcesses(managedExecutable: string): number[] {
  return listObsProcessesByPath(managedExecutable, false);
}

export function listManagedObsProcesses(managedExecutable: string): number[] {
  return listObsProcessesByPath(managedExecutable, true);
}
