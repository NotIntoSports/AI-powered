# 会议音频自动桥接 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 客户端预选会议软件后自动检测其进程出现并自动捕获音频，以长连接实时推入每场一新的 RTC 房间（LiveKit/火山云跟随管理端配置），进程退出自动停止。

**Architecture:** 渲染进程内自动化。从现有 `RtcBridgeControl.start()` 抽出 UI 无关的推流会话单例（`bridge-session.ts`），新增 localStorage 偏好存储（`auto-bridge-store.ts`）、纯函数决策状态机（`auto-bridge-decision.ts`）和全局挂载的轮询控制器（`auto-bridge-controller.tsx`，挂进 `AppChrome`）。手动与自动共享同一会话单例并互斥。零新增依赖。

**Tech Stack:** Next.js 15 + React 19 + TypeScript；测试用 `node --experimental-strip-types --test`（`npm run test:desktop-shell`）。

**规格文档:** `docs/superpowers/specs/2026-08-19-auto-meeting-bridge-design.md`

**提交约定:** 每个任务末尾有 commit 步骤；仓库安全规则要求用户明确要求才能提交——默认只执行 `git add` 并暂停等用户确认，用户未要求提交时跳过 commit 命令。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `desktop/audio/meeting-processes.ts` | 修改 | 导出白名单常量 `MEETING_EXECUTABLE_NAMES` 与显示名映射，供前端复用 |
| `features/rtc/auto-bridge-store.ts` | 新增 | localStorage 存取自动开关与预选软件；导出纯解析函数供测试 |
| `features/rtc/auto-bridge-decision.ts` | 新增 | 轮询结果的纯函数决策状态机（触发/停止/重试退避/需人工处理） |
| `features/rtc/bridge-session.ts` | 新增 | 推流会话单例：token → PCM 轨道 → transport → 捕获；含 2 秒周期 `setRtcNetwork` |
| `features/rtc/auto-bridge-controller.tsx` | 新增 | 全局组件：5 秒轮询 + 状态机驱动 + 状态发布 |
| `features/rtc/rtc-bridge-control.tsx` | 修改 | 手动启停改调 bridge-session；卡片新增自动开关/预选下拉/自动状态行 |
| `features/settings/app-chrome.tsx` | 修改 | 挂载 `<AutoBridgeController />` |
| `tests/desktop/auto-bridge-decision.test.mjs` | 新增 | 决策状态机测试 |
| `tests/desktop/auto-bridge-store.test.mjs` | 新增 | store 解析函数测试 |
| `docs/dependency-decisions.md` | 修改 | 记录「复用现有能力、零新增依赖」决策（AGENTS.md 要求） |

---

### Task 1: 导出会议软件白名单常量

**Files:**
- Modify: `desktop/audio/meeting-processes.ts:5-13`

- [ ] **Step 1: 修改白名单为导出常量并新增显示名映射**

把 `meeting-processes.ts` 顶部的 `const meetingExecutableNames = new Set([...])` 改为：

```ts
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
```

同时把 `filterMeetingProcesses` 内的 `meetingExecutableNames.has(...)` 改为 `MEETING_EXECUTABLE_NAMES.has(...)`。

- [ ] **Step 2: 运行现有测试确认无回归**

Run: `npm run test:desktop-shell`
Expected: 全部 PASS（含 `meeting-processes.test.mjs`）

- [ ] **Step 3: Commit**

```bash
git add desktop/audio/meeting-processes.ts
git commit -m "refactor: export meeting software whitelist for reuse"
```

---

### Task 2: auto-bridge-store（偏好存储，TDD）

**Files:**
- Create: `features/rtc/auto-bridge-store.ts`
- Test: `tests/desktop/auto-bridge-store.test.mjs`

- [ ] **Step 1: 写失败测试**

创建 `tests/desktop/auto-bridge-store.test.mjs`：

```js
import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAutoBridgeEnabled,
  parseAutoBridgeSoftware,
  MEETING_EXECUTABLE_NAMES
} from "../../features/rtc/auto-bridge-store.ts";

test("auto bridge defaults to disabled with no preselected software", () => {
  assert.equal(parseAutoBridgeEnabled(null), false);
  assert.equal(parseAutoBridgeSoftware(null), "");
});

test("parses saved values", () => {
  assert.equal(parseAutoBridgeEnabled("1"), true);
  assert.equal(parseAutoBridgeEnabled("true"), true);
  assert.equal(parseAutoBridgeEnabled("0"), false);
  assert.equal(parseAutoBridgeSoftware("wemeetapp.exe"), "wemeetapp.exe");
});

test("rejects software outside the whitelist", () => {
  assert.equal(parseAutoBridgeSoftware("notepad.exe"), "");
  assert.equal(parseAutoBridgeSoftware("  "), "");
});

test("whitelist comes from the desktop module", () => {
  assert.ok(MEETING_EXECUTABLE_NAMES.has("wemeetapp.exe"));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test:desktop-shell`
Expected: 新测试 FAIL（模块不存在），旧测试 PASS

- [ ] **Step 3: 实现 store**

创建 `features/rtc/auto-bridge-store.ts`：

```ts
import { MEETING_EXECUTABLE_NAMES } from "../../desktop/audio/meeting-processes.ts";

export { MEETING_EXECUTABLE_NAMES };
export { MEETING_SOFTWARE_LABELS } from "../../desktop/audio/meeting-processes.ts";

const ENABLED_KEY = "ai-auto-bridge-enabled";
const SOFTWARE_KEY = "ai-auto-bridge-software";
const CHANGE_EVENT = "ai-auto-bridge-change";

export function parseAutoBridgeEnabled(raw: string | null): boolean {
  return raw === "1" || raw === "true";
}

export function parseAutoBridgeSoftware(raw: string | null): string {
  const value = (raw || "").trim().toLowerCase();
  return MEETING_EXECUTABLE_NAMES.has(value) ? value : "";
}

export function loadAutoBridgeEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try { return parseAutoBridgeEnabled(window.localStorage.getItem(ENABLED_KEY)); }
  catch { return false; }
}

export function loadAutoBridgeSoftware(): string {
  if (typeof window === "undefined") return "";
  try { return parseAutoBridgeSoftware(window.localStorage.getItem(SOFTWARE_KEY)); }
  catch { return ""; }
}

export function saveAutoBridgeEnabled(enabled: boolean) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(ENABLED_KEY, enabled ? "1" : "0"); }
  catch { /* ignore quota / private mode */ }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function saveAutoBridgeSoftware(software: string) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(SOFTWARE_KEY, parseAutoBridgeSoftware(software)); }
  catch { /* ignore quota / private mode */ }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function subscribeAutoBridgeStore(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === ENABLED_KEY || event.key === SOFTWARE_KEY || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE_EVENT, listener);
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm run test:desktop-shell`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add features/rtc/auto-bridge-store.ts tests/desktop/auto-bridge-store.test.mjs
git commit -m "feat: persist auto audio bridge preferences"
```

---

### Task 3: auto-bridge-decision（决策状态机，TDD）

**Files:**
- Create: `features/rtc/auto-bridge-decision.ts`
- Test: `tests/desktop/auto-bridge-decision.test.mjs`

- [ ] **Step 1: 写失败测试**

创建 `tests/desktop/auto-bridge-decision.test.mjs`：

```js
import assert from "node:assert/strict";
import test from "node:test";

import {
  initialAutoBridgeMachine,
  decideAutoBridge
} from "../../features/rtc/auto-bridge-decision.ts";

const base = { now: 1000, machine: initialAutoBridgeMachine() };
const wemeet = { pid: 11, name: "WeMeetApp.exe", title: "张三的会议" };

test("idle when disabled or no software preselected", () => {
  assert.equal(decideAutoBridge([wemeet], { ...base, enabled: false, software: "wemeetapp.exe" }).action, "idle");
  assert.equal(decideAutoBridge([wemeet], { ...base, enabled: true, software: "" }).action, "idle");
});

test("manual session yields: no trigger while a bridge session runs", () => {
  const decision = decideAutoBridge([wemeet], { ...base, enabled: true, software: "wemeetapp.exe", sessionRunning: true });
  assert.equal(decision.action, "holding");
});

test("triggers capture for matching process with non-empty title", () => {
  const decision = decideAutoBridge([wemeet], { ...base, enabled: true, software: "wemeetapp.exe" });
  assert.deepEqual(decision.action, { type: "start", pid: 11 });
});

test("name match is case-insensitive and ignores other software", () => {
  const zoom = { pid: 20, name: "zoom.exe", title: "call" };
  const decision = decideAutoBridge([zoom], { ...base, enabled: true, software: "wemeetapp.exe" });
  assert.equal(decision.action, "waiting");
});

test("ignores matching process with empty title", () => {
  const noTitle = { pid: 12, name: "WeMeetApp.exe", title: "" };
  const decision = decideAutoBridge([noTitle], { ...base, enabled: true, software: "wemeetapp.exe" });
  assert.equal(decision.action, "waiting");
});

test("keeps holding while captured pid is alive", () => {
  const machine = { ...initialAutoBridgeMachine(), capturedPid: 11 };
  const decision = decideAutoBridge([wemeet], { ...base, machine, enabled: true, software: "wemeetapp.exe" });
  assert.equal(decision.action, "holding");
});

test("stops when captured pid disappears", () => {
  const machine = { ...initialAutoBridgeMachine(), capturedPid: 11 };
  const decision = decideAutoBridge([], { ...base, machine, enabled: true, software: "wemeetapp.exe" });
  assert.equal(decision.action, "stop");
  assert.equal(decision.machine.capturedPid, null);
  assert.equal(decision.machine.attempts, 0);
});

test("waits out the 10s backoff, then retries", () => {
  const machine = { ...initialAutoBridgeMachine(), attempts: 1, lastFailureAt: 1000 };
  const blocked = decideAutoBridge([wemeet], { now: 5000, machine, enabled: true, software: "wemeetapp.exe" });
  assert.equal(blocked.action, "backoff");
  const retry = decideAutoBridge([wemeet], { now: 11_001, machine, enabled: true, software: "wemeetapp.exe" });
  assert.deepEqual(retry.action, { type: "start", pid: 11 });
});

test("needs manual after 3 attempts once backoff elapses", () => {
  const exhausted = { ...initialAutoBridgeMachine(), attempts: 3, lastFailureAt: 1000 };
  const blocked = decideAutoBridge([wemeet], { now: 99_999, machine: exhausted, enabled: true, software: "wemeetapp.exe" });
  assert.equal(blocked.action, "needs-manual");
  assert.equal(blocked.machine.awaitingManual, true);
});

test("new meeting re-arms after needs-manual", () => {
  const machine = { attempts: 3, lastFailureAt: 1000, awaitingManual: true, capturedPid: null };
  const other = { pid: 30, name: "WeMeetApp.exe", title: "下一场" };
  const decision = decideAutoBridge([other], { ...base, machine, enabled: true, software: "wemeetapp.exe" });
  assert.deepEqual(decision.action, { type: "start", pid: 30 });
  assert.equal(decision.machine.awaitingManual, false);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test:desktop-shell`
Expected: 新测试 FAIL（模块不存在）

- [ ] **Step 3: 实现决策状态机**

创建 `features/rtc/auto-bridge-decision.ts`：

```ts
export const AUTO_BRIDGE_POLL_MS = 5_000;
export const AUTO_BRIDGE_BACKOFF_MS = 10_000;
export const AUTO_BRIDGE_MAX_ATTEMPTS = 3;

export type MeetingProcessLike = { pid: number; name: string; title: string };

export type AutoBridgeMachine = {
  capturedPid: number | null;
  attempts: number;
  lastFailureAt: number | null;
  awaitingManual: boolean;
};

export type AutoBridgeAction =
  | "idle"
  | "waiting"
  | "holding"
  | "backoff"
  | "stop"
  | "needs-manual"
  | { type: "start"; pid: number };

export function initialAutoBridgeMachine(): AutoBridgeMachine {
  return { capturedPid: null, attempts: 0, lastFailureAt: null, awaitingManual: false };
}

export function decideAutoBridge(
  processes: MeetingProcessLike[],
  input: {
    now: number;
    machine: AutoBridgeMachine;
    enabled: boolean;
    software: string;
    sessionRunning?: boolean;
  }
): { action: AutoBridgeAction; machine: AutoBridgeMachine } {
  const { now, enabled, software } = input;
  if (!enabled || !software) {
    return { action: "idle", machine: initialAutoBridgeMachine() };
  }
  const machine = { ...input.machine };
  const matches = processes.filter(
    (process) => process.name.toLowerCase() === software && process.title.trim() !== ""
  );
  const alive = machine.capturedPid !== null && matches.some((p) => p.pid === machine.capturedPid);

  if (!alive) {
    if (machine.capturedPid !== null) {
      // 已捕获进程消失：无论处于何种故障状态，都先停止并复位，等待下一场。
      return { action: "stop", machine: initialAutoBridgeMachine() };
    }
    machine.capturedPid = null;
    machine.attempts = 0;
    machine.awaitingManual = false;
  }

  if (input.sessionRunning) return { action: "holding", machine };

  if (machine.awaitingManual) {
    if (matches.length === 0) return { action: "waiting", machine: initialAutoBridgeMachine() };
    return { action: "needs-manual", machine };
  }

  if (machine.lastFailureAt !== null) {
    if (now - machine.lastFailureAt < AUTO_BRIDGE_BACKOFF_MS) return { action: "backoff", machine };
    if (machine.attempts >= AUTO_BRIDGE_MAX_ATTEMPTS) {
      return { action: "needs-manual", machine: { ...machine, awaitingManual: true } };
    }
  }

  const target = matches[0];
  if (!target) return { action: "waiting", machine };
  return { action: { type: "start", pid: target.pid }, machine };
}

/** 启动尝试登记（controller 在每次 startBridgeSession 调用前使用）。 */
export function recordAttempt(machine: AutoBridgeMachine, now: number): AutoBridgeMachine {
  return { ...machine, attempts: machine.attempts + 1, lastFailureAt: now };
}

/** 启动成功后登记捕获的 pid。 */
export function recordCaptured(machine: AutoBridgeMachine, pid: number): AutoBridgeMachine {
  return { ...machine, capturedPid: pid };
}

/** 启动失败后登记退避起点。 */
export function recordFailure(machine: AutoBridgeMachine, now: number): AutoBridgeMachine {
  return { ...machine, lastFailureAt: now };
}
```

注意：`decideAutoBridge` 本身不修改 attempts/lastFailureAt（保持纯函数），尝试计数由 controller 通过 `recordAttempt`（start 调用前，attempts+1 并记录退避起点）维护；启动成功后 `recordCaptured` 登记 pid（`lastFailureAt` 保留但捕获存活期间不会进入失败分支，进程消失时整体复位）；启动抛错则不额外操作，状态机已含失败信息，下一轮进入 backoff。

- [ ] **Step 4: 运行确认通过**

Run: `npm run test:desktop-shell`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add features/rtc/auto-bridge-decision.ts tests/desktop/auto-bridge-decision.test.mjs
git commit -m "feat: add auto audio bridge decision state machine"
```

---

### Task 4: bridge-session（推流会话单例）

**Files:**
- Create: `features/rtc/bridge-session.ts`
- Modify: `features/rtc/rtc-bridge-control.tsx`（本任务只做抽出，UI 改动在 Task 6）

- [ ] **Step 1: 创建 bridge-session.ts**

把 `rtc-bridge-control.tsx` 中 `createPcmTrack`、`RtcTokenResponse`、`start()`/`stop()` 的核心逻辑搬进新文件 `features/rtc/bridge-session.ts`：

```ts
import VERTC from "@volcengine/rtc";
import { createSubtitleTransport } from "../../desktop/rtc/create-transport.ts";
import { loadRemoteMonitorEnabled, subscribeRemoteMonitor } from "../audio/remote-monitor.ts";
import { setRtcNetwork } from "./network-quality.ts";
import { subtitleSink } from "../../lib/subtitles/sink.ts";
import type { SubtitleProvider, SubtitleTransport } from "../../lib/subtitles/transport.ts";

export type MeetingProcess = { pid: number; name: string; title: string };
export type DesktopBridge = {
  listMeetingProcesses(): Promise<MeetingProcess[]>;
  startAudioCapture(pid: number): Promise<{ started: true }>;
  stopAudioCapture(): Promise<{ stopped: true }>;
  onAudioPcm(listener: (data: Uint8Array) => void): () => void;
  onAudioEvent(listener: (event: unknown) => void): () => void;
};
type RtcTokenResponse = {
  provider?: SubtitleProvider;
  token?: string;
  appId?: string;
  url?: string;
  roomId?: string;
  userId?: string;
  language?: string;
  message?: string;
};

export type BridgeSessionOwner = "manual" | "auto";
export type BridgeSessionEvents = {
  onStatus(message: string): void;
  onLevel(peak: number): void;
  onProcessExited(): void;
};
export type BridgeSessionHandle = { owner: BridgeSessionOwner; roomId: string; provider: SubtitleProvider };

export function getDesktopBridge(): DesktopBridge | null {
  return (window as { aiInterviewerDesktop?: DesktopBridge }).aiInterviewerDesktop || null;
}

export function providerLabel(provider: SubtitleProvider) {
  return provider === "livekit" ? "自建 LiveKit" : "火山云 RTC";
}

// createPcmTrack 原样搬自 rtc-bridge-control.tsx（48kHz PCM16 → MediaStreamTrack，含监听增益）
function createPcmTrack(monitorEnabled: boolean) {
  const context = new AudioContext({ sampleRate: 48_000 });
  const destination = context.createMediaStreamDestination();
  const monitorGain = context.createGain();
  monitorGain.gain.value = monitorEnabled ? 1 : 0;
  monitorGain.connect(context.destination);
  let nextStart = context.currentTime;
  const push = (bytes: Uint8Array) => {
    const sampleCount = Math.floor(bytes.byteLength / 2);
    if (!sampleCount) return;
    const buffer = context.createBuffer(1, sampleCount, 48_000);
    const channel = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < sampleCount; index += 1) channel[index] = view.getInt16(index * 2, true) / 32768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);
    source.connect(monitorGain);
    nextStart = Math.max(nextStart, context.currentTime + 0.02);
    source.start(nextStart);
    nextStart += buffer.duration;
  };
  return {
    context,
    track: destination.stream.getAudioTracks()[0],
    push,
    setMonitorEnabled(enabled: boolean) { monitorGain.gain.value = enabled ? 1 : 0; }
  };
}

type ActiveSession = {
  handle: BridgeSessionHandle;
  events: BridgeSessionEvents;
  cleanup: () => Promise<void>;
};
let active: ActiveSession | null = null;

export function isBridgeSessionRunning(): boolean {
  return active !== null;
}

export function getBridgeSessionHandle(): BridgeSessionHandle | null {
  return active?.handle || null;
}

export function makeBridgeRoomId(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomUUID().replaceAll("-", "").slice(0, 4)}`;
}

export async function startBridgeSession(
  pid: number,
  owner: BridgeSessionOwner,
  roomIdPrefix: string,
  events: BridgeSessionEvents
): Promise<BridgeSessionHandle> {
  if (active) throw new Error("BRIDGE_SESSION_ALREADY_RUNNING");
  const bridge = getDesktopBridge();
  if (!bridge) throw new Error("请在 Windows 客户端中使用音频桥接功能。");
  events.onStatus("正在建立音频轨道和字幕线路…");
  const sessionId = makeBridgeRoomId(roomIdPrefix);
  const userId = `bridge_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const tokenResponse = await fetch("/api/rtc/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId: sessionId, userId })
  });
  const token = await tokenResponse.json() as RtcTokenResponse;
  if (!tokenResponse.ok) throw new Error(token.message || "RTC Token 获取失败");
  const activeProvider: SubtitleProvider = token.provider === "livekit" ? "livekit" : "volcengine";
  const language = token.language || "zh";
  const roomId = token.roomId || sessionId;
  const pcm = createPcmTrack(loadRemoteMonitorEnabled());
  const stopMonitorSync = subscribeRemoteMonitor(() => pcm.setMonitorEnabled(loadRemoteMonitorEnabled()));
  subtitleSink.reset();
  let engine: ReturnType<typeof VERTC.createEngine> | undefined;
  let transport: SubtitleTransport;
  if (activeProvider === "volcengine") {
    if (!token.appId || !token.token) throw new Error("RTC Token 获取失败");
    engine = VERTC.createEngine(token.appId);
    transport = await createSubtitleTransport("volcengine", subtitleSink, engine as never);
  } else {
    transport = await createSubtitleTransport("livekit", subtitleSink);
  }
  await transport.connect({
    sessionId,
    language,
    track: pcm.track,
    token: token.token || "",
    roomId,
    userId: token.userId || userId,
    appId: token.appId,
    url: token.url
  });
  const removePcm = bridge.onAudioPcm(pcm.push);
  const removeEvent = bridge.onAudioEvent((event) => {
    const value = event as { type?: string; peak?: number; message?: string };
    if (value.type === "level") events.onLevel(value.peak || 0);
    if (value.type === "process-exited") events.onProcessExited();
    if (value.type === "error") events.onStatus(value.message || "音频捕获失败");
  });
  await bridge.startAudioCapture(pid);

  const statsTimer = window.setInterval(() => {
    const stats = transport.getNetworkStats?.();
    Promise.resolve(stats).then((value) => {
      setRtcNetwork({ connected: true, rttMs: value?.rttMs ?? null, packetLossPct: value?.packetLossPct ?? null });
    }).catch(() => undefined);
  }, 2_000);

  const handle: BridgeSessionHandle = { owner, roomId, provider: activeProvider };
  active = {
    handle,
    events,
    cleanup: async () => {
      window.clearInterval(statsTimer);
      removePcm();
      removeEvent();
      stopMonitorSync();
      setRtcNetwork({ connected: false });
      await bridge.stopAudioCapture().catch(() => undefined);
      await transport.disconnect().catch(() => undefined);
      if (engine) VERTC.destroyEngine(engine);
      pcm.track.stop();
      await pcm.context.close().catch(() => undefined);
      subtitleSink.reset(sessionId);
    }
  };
  return handle;
}

export async function stopBridgeSession(): Promise<void> {
  const session = active;
  if (!session) return;
  active = null;
  await session.cleanup();
}
```

要点对照现状：
- `getNetworkStats` 的轮询从组件 `useEffect` 搬入会话内部（规格：内部 2 秒周期 `setRtcNetwork`）。
- 监听开关联动从组件 `useEffect` 搬入会话（`subscribeRemoteMonitor`）。
- 原 `start()` 里 level 事件直接 setStatus 的行为改为 `events.onLevel`，由 UI/控制器决定文案。

- [ ] **Step 2: 改造 rtc-bridge-control.tsx 使用会话单例**

替换该组件内 `createPcmTrack`、`start()`、`stop()`、`providerLabel`、类型定义与网络/监听两个 useEffect 为调用 bridge-session。组件保留进程列表刷新与 UI。关键替换：

```tsx
import {
  getDesktopBridge,
  isBridgeSessionRunning,
  providerLabel,
  startBridgeSession,
  stopBridgeSession,
  type MeetingProcess
} from "./bridge-session.ts";
// 删除：VERTC、createSubtitleTransport、subtitleSink、createPcmTrack、RtcTokenResponse、
// remote-monitor 与 network-quality 的 import 中不再使用的部分（describeNetwork/getNetworkQuality/subscribeNetworkQuality 仍用于展示）

// start()：
async function start() {
  if (!pid) return;
  try {
    const handle = await startBridgeSession(pid, "manual", "interview", {
      onStatus: setStatus,
      onLevel: (peak) => setStatus(`${providerLabel(handle.provider)} 运行中 · 对方音量 ${Math.round(peak * 100)}%`),
      onProcessExited: () => void stop()
    });
    setProvider(handle.provider);
    setRunning(true);
    setStatus(
      loadRemoteMonitorEnabled()
        ? `${providerLabel(handle.provider)} 运行中；本机正在播放对方声音（可在「监听与人工介入」关闭）。`
        : `${providerLabel(handle.provider)} 运行中；本机未播放对方声音，请用会议软件收听。`
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "启动失败");
  }
}

// stop()：
async function stop() {
  await stopBridgeSession();
  setRunning(false);
  setStatus("字幕和会议进程捕获已停止。");
}
```

`refresh()` 改用 `getDesktopBridge()`；`useEffect(() => { void refresh(); return () => { void stopBridgeSession(); }; }, [])` 取代原清理。删除组件内已不使用的 ref（cleanupRef/transportRef/monitorRef）与网络轮询 useEffect（保留 network 状态展示，`subscribeNetworkQuality` 的 useEffect 不动）。

- [ ] **Step 3: 构建验证**

Run: `npm run build`
Expected: 构建成功，无类型错误

Run: `npm run test:desktop-shell`
Expected: 全部 PASS

- [ ] **Step 4: Commit**

```bash
git add features/rtc/bridge-session.ts features/rtc/rtc-bridge-control.tsx
git commit -m "refactor: extract RTC bridge session controller from settings card"
```

---

### Task 5: auto-bridge-controller（全局轮询控制器）

**Files:**
- Create: `features/rtc/auto-bridge-controller.tsx`
- Modify: `features/settings/app-chrome.tsx`

- [ ] **Step 1: 实现控制器组件**

创建 `features/rtc/auto-bridge-controller.tsx`：

```tsx
"use client";

import { useEffect, useState } from "react";
import {
  AUTO_BRIDGE_POLL_MS,
  decideAutoBridge,
  initialAutoBridgeMachine,
  recordAttempt,
  recordCaptured,
  recordFailure,
  type AutoBridgeMachine
} from "./auto-bridge-decision.ts";
import {
  getDesktopBridge,
  isBridgeSessionRunning,
  getBridgeSessionHandle,
  providerLabel,
  startBridgeSession,
  stopBridgeSession
} from "./bridge-session.ts";
import {
  loadAutoBridgeEnabled,
  loadAutoBridgeSoftware,
  subscribeAutoBridgeStore,
  MEETING_SOFTWARE_LABELS
} from "./auto-bridge-store.ts";

export type AutoBridgeStatus = {
  text: string;
  state: "off" | "waiting" | "captured" | "backoff" | "needs-manual" | "starting";
};

const STATUS_EVENT = "ai-auto-bridge-status";

export function subscribeAutoBridgeStatus(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(STATUS_EVENT, listener);
  return () => window.removeEventListener(STATUS_EVENT, listener);
}

let latestStatus: AutoBridgeStatus = { text: "已关闭", state: "off" };
export function getAutoBridgeStatus(): AutoBridgeStatus {
  return latestStatus;
}
function publishStatus(next: AutoBridgeStatus) {
  if (latestStatus.text === next.text && latestStatus.state === next.state) return;
  latestStatus = next;
  window.dispatchEvent(new CustomEvent(STATUS_EVENT));
}

/** 全局挂载：仅 Electron 客户端内生效，无可见 UI。 */
export function AutoBridgeController() {
  const [, forceRender] = useState(0);

  useEffect(() => {
    const stopStoreSync = subscribeAutoBridgeStore(() => forceRender((value) => value + 1));
    let machine: AutoBridgeMachine = initialAutoBridgeMachine();
    let busy = false;
    let disposed = false;

    async function tick() {
      if (busy || disposed) return;
      busy = true;
      try {
        const enabled = loadAutoBridgeEnabled();
        const software = loadAutoBridgeSoftware();
        if (!enabled || !software) {
          machine = initialAutoBridgeMachine();
          publishStatus({ text: "已关闭", state: "off" });
          return;
        }
        const bridge = getDesktopBridge();
        const processes = bridge ? await bridge.listMeetingProcesses() : [];
        const manualRunning = isBridgeSessionRunning() && getBridgeSessionHandle()?.owner === "manual";
        const decision = decideAutoBridge(processes, {
          now: Date.now(),
          machine,
          enabled,
          software,
          sessionRunning: isBridgeSessionRunning()
        });
        machine = decision.machine;
        const action = decision.action;
        if (action === "idle") { publishStatus({ text: "已关闭", state: "off" }); return; }
        if (action === "waiting") { publishStatus({ text: `等待中（每5秒检测 ${MEETING_SOFTWARE_LABELS[software] || software}）`, state: "waiting" }); return; }
        if (action === "holding") {
          if (manualRunning) return; // 手动会话自己维护状态文案
          const handle = getBridgeSessionHandle();
          publishStatus(handle
            ? { text: `已自动捕获 · 房间 ${handle.roomId}（${providerLabel(handle.provider)}）`, state: "captured" }
            : { text: "等待中（每5秒检测）", state: "waiting" });
          return;
        }
        if (action === "backoff") { publishStatus({ text: "重试等待中…", state: "backoff" }); return; }
        if (action === "needs-manual") { publishStatus({ text: "需人工处理：自动推流连续失败，请到「会议音频桥接」手动启动", state: "needs-manual" }); return; }
        if (action === "stop") {
          if (isBridgeSessionRunning() && getBridgeSessionHandle()?.owner === "auto") await stopBridgeSession();
          publishStatus({ text: "等待中（每5秒检测）", state: "waiting" });
          return;
        }
        // action = { type: "start", pid }
        publishStatus({ text: "检测到会议，正在自动建立推流…", state: "starting" });
        machine = recordAttempt(machine, Date.now());
        try {
          await startBridgeSession(action.pid, "auto", "meet", {
            onStatus: (message) => publishStatus({ text: message, state: "captured" }),
            onLevel: () => undefined,
            onProcessExited: () => {
              if (getBridgeSessionHandle()?.owner === "auto") void stopBridgeSession();
            }
          });
          machine = recordCaptured(machine, action.pid);
        } catch (cause) {
          machine = recordFailure(machine, Date.now());
          publishStatus({ text: `自动推流失败：${cause instanceof Error ? cause.message : "未知错误"}`, state: "backoff" });
        }
      } finally {
        busy = false;
      }
    }

    void tick();
    const timer = window.setInterval(() => void tick(), AUTO_BRIDGE_POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      stopStoreSync();
      if (isBridgeSessionRunning() && getBridgeSessionHandle()?.owner === "auto") void stopBridgeSession();
    };
  }, []);

  return null;
}
```

说明：
- 自动开关被关闭时（store 变化触发 forceRender 后下一轮 tick），仅当当前会话 owner 为 auto 才停止，手动会话不受影响（规格行为 8）。
- 组件卸载（页面销毁）时停止自动会话，防止悬挂进程。

- [ ] **Step 2: 挂载到 AppChrome**

修改 `features/settings/app-chrome.tsx`：

```tsx
"use client";

import { UserAccountMenu, type AccountPage } from "./user-account-menu";
import { UploadMaterialsDock, type UploadMaterialsDockProps } from "./upload-materials-dock";
import { AutoBridgeController } from "../rtc/auto-bridge-controller";

export function AppChrome({
  current,
  upload
}: {
  current: AccountPage;
  upload?: UploadMaterialsDockProps;
}) {
  return (
    <>
      <AutoBridgeController />
      {upload ? (
        <div className="uploadDockAnchor">
          <UploadMaterialsDock {...upload} />
        </div>
      ) : null}
      <UserAccountMenu current={current} />
    </>
  );
}
```

- [ ] **Step 3: 构建验证**

Run: `npm run build`
Expected: 构建成功

Run: `npm run test:desktop-shell`
Expected: 全部 PASS

- [ ] **Step 4: Commit**

```bash
git add features/rtc/auto-bridge-controller.tsx features/settings/app-chrome.tsx
git commit -m "feat: auto-detect meeting process and push audio to RTC room"
```

---

### Task 6: 设置页卡片 UI（自动开关 / 预选软件 / 状态行）

**Files:**
- Modify: `features/rtc/rtc-bridge-control.tsx`

- [ ] **Step 1: 增加自动模式 UI**

在 `RtcBridgeControl` 组件内新增状态与控件（插在现有「会议软件进程」下拉之后、按钮区之前）：

```tsx
import {
  loadAutoBridgeEnabled,
  loadAutoBridgeSoftware,
  saveAutoBridgeEnabled,
  saveAutoBridgeSoftware,
  subscribeAutoBridgeStore,
  MEETING_EXECUTABLE_NAMES,
  MEETING_SOFTWARE_LABELS
} from "./auto-bridge-store.ts";
import {
  getAutoBridgeStatus,
  subscribeAutoBridgeStatus
} from "./auto-bridge-controller.tsx";

// 组件内：
const [autoEnabled, setAutoEnabled] = useState(loadAutoBridgeEnabled);
const [autoSoftware, setAutoSoftware] = useState(loadAutoBridgeSoftware);
const [autoStatus, setAutoStatus] = useState(getAutoBridgeStatus);

useEffect(() => {
  const stopStore = subscribeAutoBridgeStore(() => {
    setAutoEnabled(loadAutoBridgeEnabled());
    setAutoSoftware(loadAutoBridgeSoftware());
  });
  const stopStatus = subscribeAutoBridgeStatus(() => setAutoStatus(getAutoBridgeStatus()));
  return () => { stopStore(); stopStatus(); };
}, []);
```

JSX（放在进程下拉 `<label>` 之后）：

```tsx
<label className="autoFollowup">
  <input
    type="checkbox"
    checked={autoEnabled}
    disabled={!autoSoftware && !autoEnabled}
    onChange={(event) => {
      setAutoEnabled(event.target.checked);
      saveAutoBridgeEnabled(event.target.checked);
    }}
  />
  <span>
    <strong>自动听取</strong>
    <small>检测到预选会议软件开启后自动捕获并推流；散会自动停止。</small>
  </span>
</label>
<label>预选会议软件
  <select
    value={autoSoftware}
    disabled={running}
    onChange={(event) => {
      setAutoSoftware(event.target.value);
      saveAutoBridgeSoftware(event.target.value);
    }}
  >
    <option value="">未选择（自动听取不生效）</option>
    {[...MEETING_EXECUTABLE_NAMES].map((name) => (
      <option key={name} value={name}>{MEETING_SOFTWARE_LABELS[name] || name}</option>
    ))}
  </select>
</label>
{autoEnabled && autoSoftware ? (
  <p className="muted">自动状态：{autoStatus.text}</p>
) : null}
```

- [ ] **Step 2: 构建与类型检查**

Run: `npm run build`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git add features/rtc/rtc-bridge-control.tsx
git commit -m "feat: expose auto audio bridge controls in settings card"
```

---

### Task 7: 依赖决策记录 + 全量验证

**Files:**
- Modify: `docs/dependency-decisions.md`

- [ ] **Step 1: 追加决策记录**

在 `docs/dependency-decisions.md` 末尾按现有条目格式追加（如现有格式不同则对齐现有格式）：

```markdown
## 2026-08-19 会议音频自动桥接（自动检测会议进程并推流到 RTC 房间）

- 结论：零新增依赖，复用现有能力。
- 复用：Electron IPC `listMeetingProcesses` / AudioBridge 捕获；`/api/rtc/token` + LiveKit/火山云 transport；localStorage 偏好模式（remote-monitor.ts）。
- 已评估并弃用：`@livekit/rtc-node`（主进程推流）——火山云无对应 Node SDK，双供应商无法统一，且违反「优先复用现有能力」。
- 设计文档：docs/superpowers/specs/2026-08-19-auto-meeting-bridge-design.md
```

- [ ] **Step 2: 全量验证**

Run: `npm run build && npm run build:desktop && npm run test:desktop-shell`
Expected: 三项全部成功

- [ ] **Step 3: 手动冒烟（需要真实环境，交付说明中列出结果）**

1. 启动 Electron 客户端（`Start-AI-Virtual-Assistant.cmd` 或现有启动方式）。
2. 设置页 → 会议音频桥接：预选「腾讯会议」并开启「自动听取」。
3. 启动腾讯会议 → 确认状态行变为「已自动捕获 · 房间 meet_…」。
4. LiveKit 侧确认房间存在且有音频流（或观察对方音量事件）。
5. 散会（退出腾讯会议进程）→ 状态回到「等待中」。
6. 关闭自动开关 → 若正在推流应立即停止。

- [ ] **Step 4: Commit**

```bash
git add docs/dependency-decisions.md
git commit -m "docs: record dependency decision for auto meeting bridge"
```

---

## 自查记录

- 规格覆盖：自动检测/触发（Task 3/5）、每场一房推流（Task 4/5）、自动停止（Task 3 stop/Task 5 onProcessExited）、失败退避 3 次（Task 3）、手动让位（Task 3 holding + Task 5 manualRunning）、UI 三要素（Task 6）、单测（Task 2/3）、依赖决策（Task 7）、管理端不改动（未涉及管理端文件）。全部覆盖。
- 类型一致性：`BridgeSessionHandle.owner/roomId/provider`、`decideAutoBridge` 返回结构、store 函数名在各任务间一致。
- 无占位符。
