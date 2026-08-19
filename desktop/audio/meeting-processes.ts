import { execFile } from "node:child_process";
import { promisify } from "node:util";

// 会议进程白名单。注意：不从 meeting-software 导入——该常量模块供客户端 bundle 共用，
// 而 desktop 侧源码需同时满足 tsc(CommonJS) 编译与 Node strip-types 直接加载（后者要求显式 .ts
// 扩展名，前者禁止），跨文件导入无法两全；此处与 meeting-software.ts 的白名单保持同步，
// 由 tests/desktop/meeting-whitelist-sync.test.mjs 一致性测试守卫。
export const MEETING_EXECUTABLE_NAMES: ReadonlySet<string> = new Set([
  "teams.exe",
  "ms-teams.exe",
  "wemeetapp.exe",
  "feishu.exe",
  "lark.exe",
  "dingtalk.exe",
  "zoom.exe"
]);

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
