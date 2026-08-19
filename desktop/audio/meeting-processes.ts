import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MEETING_EXECUTABLE_NAMES } from "./meeting-software.ts";

export { MEETING_EXECUTABLE_NAMES, MEETING_SOFTWARE_LABELS } from "./meeting-software.ts";

const execFileAsync = promisify(execFile);

export type MeetingProcess = {
  pid: number;
  name: string;
  title: string;
};

export function filterMeetingProcesses(processes: unknown[]): MeetingProcess[] {
  return processes
    .flatMap((process) => {
      if (!process || typeof process !== "object") return [];
      const value = process as Record<string, unknown>;
      const pid = typeof value.pid === "number" ? value.pid : Number(value.pid);
      const name = typeof value.name === "string" ? value.name : "";
      const title = typeof value.title === "string" ? value.title : "";
      return Number.isInteger(pid) && pid > 0 && title.trim() && MEETING_EXECUTABLE_NAMES.has(name.toLowerCase())
        ? [{ pid, name, title }]
        : [];
    })
    .sort((left, right) => left.name.localeCompare(right.name) || left.pid - right.pid);
}

export async function listMeetingProcesses(): Promise<MeetingProcess[]> {
  if (process.platform !== "win32") return [];
  const script = [
    "Get-Process | Where-Object { $_.MainWindowTitle } |",
    "Select-Object @{n='pid';e={$_.Id}},@{n='name';e={$_.Path | Split-Path -Leaf}},@{n='title';e={$_.MainWindowTitle}} |",
    "ConvertTo-Json -Compress"
  ].join(" ");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, maxBuffer: 1024 * 1024 }
  );
  if (!stdout.trim()) return [];
  const raw = JSON.parse(stdout) as unknown;
  return filterMeetingProcesses(Array.isArray(raw) ? raw : [raw]);
}
