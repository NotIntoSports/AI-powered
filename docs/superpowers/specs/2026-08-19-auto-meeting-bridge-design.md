# 会议音频自动桥接设计（Auto Meeting Bridge）

日期：2026-08-19
状态：已确认，待实施

## 背景与目标

当前「会议音频桥接」（`features/rtc/rtc-bridge-control.tsx`）要求用户手动选择会议进程并点击启动，房间为一次性字幕房。目标：

1. 客户端预先选定一款会议软件后，后台自动检测该软件的会议进程出现（= 会议开始），自动启动音频捕获。
2. 捕获的音频以长连接实时推入本场会议专属的 RTC 房间（语音房）：房间 ID 每场一新，provider 跟随管理端 RTC 配置（LiveKit / 火山云，由 `/api/rtc/token` 决定）。
3. 会议进程退出后自动停止推流并释放资源。

非目标（YAGNI）：

- 管理端不收听、不新增语音房页面；房间音频流如何消费（服务端转写/存档）不在本期范围。
- 人工介入仍由客户端现有能力（`human-takeover-control.tsx`）承担，不改动。
- 不做「已入会 vs 仅打开主界面」的严格区分：进程出现且窗口标题非空即视为会议开始（可能早几秒推静音流，无害）。
- 不改动浏览器 `getDisplayMedia` 线路（工作台「开始听取对方」），该线路无法自动化且与本特性无关。

## 方案选择

- **方案 A（采用）：渲染进程内自动化。** 全局组件在页面层轮询现有 `listMeetingProcesses()`，命中后复用现有推流链路。零新依赖，双供应商（LiveKit/火山云）自动兼容；Electron 窗口最小化时渲染进程照常运行。
- 方案 B（弃用）：主进程 + `@livekit/rtc-node` 直接推流。火山云无 Node SDK，双线路无法统一，且需新增依赖、重写 PCM→RTC 逻辑，违反 AGENTS.md「优先复用现有能力」。
- 方案 C（弃用）：主进程检测 + 通知渲染进程执行。比 A 多一层 IPC，收益极小。

依赖合规：零新增依赖，按 AGENTS.md 属于「现有项目已经提供的能力」，实施时在 `docs/dependency-decisions.md` 记录一条复用决策。

## 模块结构

| 模块 | 类型 | 职责 |
|---|---|---|
| `features/rtc/bridge-session.ts` | 新增 | 从 `RtcBridgeControl.start()` 抽出的与 UI 无关的推流会话控制器：token 获取 → PCM 轨道 → transport 连接 → 捕获启停；暴露 `start(pid, opts)`、`stop()`、状态回调（status 文案 / level / process-exited / error）；网络统计沿用现状：内部按 2 秒周期调 `setRtcNetwork`，UI 继续通过 `subscribeNetworkQuality` 读取 |
| `features/rtc/auto-bridge-store.ts` | 新增 | 持久化「自动开关 + 预选软件名」到 localStorage，模式照搬 `features/audio/remote-monitor.ts`（load / save / subscribe，含跨标签 storage 事件） |
| `features/rtc/auto-bridge-controller.tsx` | 新增 | 全局挂载组件（挂进 `features/settings/app-chrome`，保证每个页面在场）：轮询检测、自动启停、状态发布 |
| `features/rtc/rtc-bridge-control.tsx` | 改造 | UI 交互不变，内部改调 `bridge-session.ts`；卡片新增自动开关、预选软件下拉、自动状态行 |

### bridge-session.ts 接口

```ts
export type BridgeSessionState = "idle" | "connecting" | "running" | "error";
export type BridgeSessionEvents = {
  onState(state: BridgeSessionState, detail: string): void;
  onLevel(peak: number): void;
  onProcessExited(): void;
};
export function startBridgeSession(pid: number, roomIdPrefix: string, events: BridgeSessionEvents): Promise<{ roomId: string }>;
export function stopBridgeSession(): Promise<void>;
export function isBridgeSessionRunning(): boolean;
```

- `roomIdPrefix`：手动模式传 `interview`（保持现状），自动模式传 `meet`；最终 roomId 形如 `meet_1755600000000_a3f9`。
- 会话为模块级单例：同一时刻最多一个推流会话，手动与自动共享该单例并互斥。

### auto-bridge-store.ts

存储键与值：

- `ai-auto-bridge-enabled`：`"1"` / `"0"`，默认关。
- `ai-auto-bridge-software`：预选软件可执行名小写（如 `wemeetapp.exe`），默认空 = 未选择。

预选候选列表 = `desktop/audio/meeting-processes.ts` 的白名单（teams.exe / ms-teams.exe / wemeetapp.exe / feishu.exe / lark.exe / dingtalk.exe / zoom.exe）。白名单以导出常量形式从该文件复用，避免两处维护。

### auto-bridge-controller.tsx 行为

1. 仅在 `window.aiInterviewerDesktop` 存在（Electron 客户端）且自动开关开启且已预选软件时工作。
2. 每 5 秒调用 `listMeetingProcesses()`。
3. **触发**：列表中出现 `name.toLowerCase() === 预选软件` 且 `title` 非空的进程，且当前无运行中的桥接会话（含手动启动的）→ 以该 pid 调 `startBridgeSession(pid, "meet", ...)`。多个命中时取列表第一个（白名单过滤后已按名称/pid 排序）。
4. **防重复**：记录已捕获 pid；该 pid 仍在列表中则不重复触发。
5. **自动停止**：收到 `onProcessExited`，或轮询发现已捕获 pid 消失 → `stopBridgeSession()`，回到等待状态继续轮询。
6. **失败退避**：`startBridgeSession` 失败或运行中转 error 时，10 秒退避后若进程仍存在则重试；同一场会议（同一 pid）最多重试 3 次，超限后进入「需人工处理」状态，停止自动重试，直到该进程消失（视为下一场）或用户关闭再开启自动开关。
7. **手动让位**：手动桥接（设置页按钮）运行时，自动逻辑不触发新会话；手动会话结束后恢复正常检测。
8. 自动开关关闭：立即停止当前自动启动的会话（手动启动的会话不受影响），清空已捕获 pid。

## 房间与推流细节

- token：沿用 `/api/rtc/token`（本地 Next 路由转发 control-api `/api/v1/client/rtc/token`），provider 由管理端 `activeProvider` 决定。
- 每场会议一个房间：roomId = `{prefix}_{timestamp}_{4位随机}`；会议进程退出即断开 transport，房间随 LiveKit/火山云默认策略销毁。
- PCM 不落盘；本机是否播放对方声音仍由工作台监听开关（`remote-monitor.ts`）控制，行为不变。

## UI 变更（仅设置页「会议音频桥接」卡片）

- 新增「自动听取」开关（自动模式总开关）。
- 新增「预选会议软件」下拉：选项为白名单软件显示名；运行中禁用。
- 新增一行自动状态文案：`等待中（每5秒检测）` / `已自动捕获 {name} · 房间 {roomId}` / `重试中（第N次）` / `需人工处理：{原因}` / `已关闭`。
- 工作台与其他页面不新增 UI。

## 测试计划

1. 单元测试（`node:test` + assert，放 `tests/desktop/`，仿 `meeting-processes.test.mjs`）：
   - 自动判定纯函数：命中触发、名称不符忽略、标题为空忽略、重复 pid 忽略、pid 消失判定停止。
   - 重试计数与退避状态机：3 次上限、进程消失重置计数、手动会话在运行时不触发。
   - store 读写：默认值、保存后读取、非法值回退。
2. 构建与类型检查：`npm run build`（含 tsconfig.desktop）。
3. 手动冒烟：Electron 客户端开启自动 + 预选腾讯会议 → 启动腾讯会议 → 确认自动起房（LiveKit 侧可见房间）；散会 → 自动停止；中途关闭自动开关 → 立即停止。

## 假设与限制

- 客户端（Electron）必须处于运行状态；窗口最小化不影响。
- 「会议开始」= 白名单进程出现且窗口标题非空；个别软件登录后即有标题，可能早几秒开始推流（静音流，无害）。
- 预选软件同时开多个实例时只捕获排序第一个；如需多实例并行属于后续需求。
- 火山云 trial 模式下房间固定为 trial 房，自动模式同样受此限制（现状行为，不改变）。
