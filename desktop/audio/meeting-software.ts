/**
 * 纯常量模块（不含任何 Node API），可安全进入浏览器/客户端 bundle。
 * meeting-processes.ts（Node 侧）与 auto-bridge-store.ts（客户端侧）共用。
 */

export const MEETING_EXECUTABLE_NAMES: ReadonlySet<string> = new Set([
  "teams.exe",
  "ms-teams.exe",
  "wemeetapp.exe",
  "feishu.exe",
  "lark.exe",
  "dingtalk.exe",
  "zoom.exe"
]);

/** 前端下拉框显示名；键为小写可执行名。 */
export const MEETING_SOFTWARE_LABELS: Record<string, string> = {
  "teams.exe": "Microsoft Teams",
  "ms-teams.exe": "Microsoft Teams (新版)",
  "wemeetapp.exe": "腾讯会议",
  "feishu.exe": "飞书",
  "lark.exe": "Lark",
  "dingtalk.exe": "钉钉",
  "zoom.exe": "Zoom"
};
