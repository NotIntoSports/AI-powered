# Volcengine RTC Audio Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在任意第三方会议软件之外增加火山引擎 RTC 实时字幕、同机监听和按住说话人工介入，同时保持 AI API 与模型由用户配置。

**Architecture:** 独立 Windows 音频 sidecar 按会议进程捕获 PCM，并通过火山官方 RTC SDK 自定义音频源发送到字幕房间；Electron 通过本地命名管道接收字幕和电平事件。AI TTS 与真实麦克风经过互斥混音后写入开源虚拟麦克风，人工介入始终优先。

**Tech Stack:** Electron、Next.js、火山引擎官方 RTC Electron/Windows SDK、Windows Application Loopback API、Windows SAPI、Node test runner、C++/CMake sidecar（仅在官方 Electron SDK不能满足外部 PCM 与字幕回调时启用）。

## Global Constraints

- 候选人仍使用腾讯会议、飞书、钉钉、Teams 等任意第三方会议软件。
- 火山 RTC 仅承载捕获音频与实时字幕，不替代会议软件。
- AI API 地址、API Key、模型名称和参数由用户填写，不写死供应商或模型。
- 正式模式不得在客户端保存 RTC AppKey，只接受短期 Token；临时 Token 只用于明确标识的试用模式。
- 原始音频默认不保存；最终字幕才进入 AI 上下文和报告。
- 监听复用会议软件原始播放，不重放捕获音频。
- 人工介入优先于 AI，松开按键后 AI 保持暂停。
- 优先官方 SDK 和 Windows API，不自研驱动，不复制微软示例的大段源码。

---

### Task 1: 官方 SDK 能力与许可闸门

**Files:**
- Modify: `docs/dependency-decisions.md`
- Create: `lib/rtc/rtc-capabilities.ts`
- Create: `scripts/test-rtc-capabilities.mjs`

**Interfaces:**
- Produces: `RtcCapabilities { externalPcm: boolean; subtitles: boolean; electron: boolean; redistributable: boolean }`。

- [ ] **Step 1: 获取官方 SDK 包和许可文本**

只从火山引擎控制台或官方 SDK 下载页获取当前 Windows/Electron SDK，记录版本、SHA-256、许可、重分发条件、外部 PCM、`startSubtitle` 和字幕回调支持情况。

- [ ] **Step 2: 写失败测试**

测试能力清单必须同时声明外部 PCM、字幕和重分发结论；任何字段缺失时发布状态为 blocked。

- [ ] **Step 3: 实现并验证能力清单**

Run: `node scripts/test-rtc-capabilities.mjs`
Expected: PASS；若官方许可尚未取得，允许开发适配接口，但 `redistributable` 为 false 并阻断安装包。

- [ ] **Step 4: 提交**

Run: `git add docs/dependency-decisions.md lib/rtc/rtc-capabilities.ts scripts/test-rtc-capabilities.mjs && git commit -m "docs: gate Volcengine RTC integration"`

### Task 2: 会议进程选择与音频捕获协议

**Files:**
- Create: `desktop/audio/capture-protocol.ts`
- Create: `desktop/audio/meeting-processes.ts`
- Create: `tests/desktop/audio-capture-protocol.test.mjs`
- Create: `tests/desktop/meeting-processes.test.mjs`

**Interfaces:**
- Produces: `listMeetingProcesses(): Promise<MeetingProcess[]>`、`AudioCaptureCommand`、`AudioCaptureEvent`。

- [ ] **Step 1: 写失败测试**

覆盖进程树选择、同名多进程、进程退出、PCM 格式协商、序列号、电平事件和全设备捕获降级警告。

- [ ] **Step 2: 实现类型化协议与进程探测**

协议使用逐行 JSON 控制消息，PCM 使用独立命名管道；会议进程仅从用户可见且存在音频会话的进程中选择。

- [ ] **Step 3: 验证并提交**

Run: `node --test tests/desktop/audio-capture-protocol.test.mjs tests/desktop/meeting-processes.test.mjs`
Expected: PASS。

Run: `git add desktop/audio tests/desktop && git commit -m "feat: define meeting audio capture protocol"`

### Task 3: Windows 应用级音频 Sidecar

**Files:**
- Create: `native/audio-bridge/CMakeLists.txt`
- Create: `native/audio-bridge/src/main.cpp`
- Create: `native/audio-bridge/src/application-loopback.cpp`
- Create: `native/audio-bridge/src/application-loopback.h`
- Create: `native/audio-bridge/tests/protocol-test.cpp`
- Create: `scripts/build-audio-bridge.ps1`

**Interfaces:**
- Consumes: 目标 PID、捕获模式和 PCM 协议。
- Produces: 48 kHz、16-bit、单声道 PCM 帧及电平/错误事件。

- [ ] **Step 1: 写原生协议失败测试**

测试启动握手、10 ms PCM 帧、静音帧、进程退出和无权限错误映射。

- [ ] **Step 2: 实现微软官方接口的最小适配**

使用 `ActivateAudioInterfaceAsync` 和 process loopback activation params 捕获指定进程树；不保存 WAV，不在 sidecar 中实现字幕或业务逻辑。

- [ ] **Step 3: 实现系统级降级模式**

只有用户确认后才允许 WASAPI endpoint loopback；事件中固定携带 `captureScope: "system"`，供 UI 显示风险。

- [ ] **Step 4: 构建验证并提交**

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-audio-bridge.ps1 -RunTests`
Expected: 原生测试 PASS。

Run: `git add native/audio-bridge scripts/build-audio-bridge.ps1 && git commit -m "feat: capture meeting process audio on Windows"`

### Task 4: 火山 RTC 字幕适配层

**Files:**
- Create: `desktop/rtc/volcengine-adapter.ts`
- Create: `desktop/rtc/subtitle-merge.ts`
- Create: `desktop/rtc/token-policy.ts`
- Create: `tests/desktop/volcengine-adapter.test.mjs`
- Create: `tests/desktop/subtitle-merge.test.mjs`

**Interfaces:**
- Produces: `connectRtc(config): Promise<RtcSession>`、`pushPcm(frame): void`、`mergeSubtitle(state, event): SubtitleState`。

- [ ] **Step 1: 写失败测试**

使用假 RTC 端口覆盖进房、推送 PCM、开启字幕、增量/最终字幕乱序、Token 到期、断线和停止清理。

- [ ] **Step 2: 实现官方 SDK 薄适配**

SDK 调用集中在单一模块；不能加载 SDK 时返回结构化 `rtc-sdk-unavailable`，不回退到未批准的第三方语音 API。

- [ ] **Step 3: 实现字幕归并与验证**

Run: `node --test tests/desktop/volcengine-adapter.test.mjs tests/desktop/subtitle-merge.test.mjs`
Expected: PASS。

- [ ] **Step 4: 提交**

Run: `git add desktop/rtc tests/desktop && git commit -m "feat: add Volcengine RTC live subtitles"`

### Task 5: 可配置 AI 与 RTC 设置

**Files:**
- Modify: `features/settings/model-settings.tsx`
- Create: `features/settings/rtc-settings.tsx`
- Create: `app/api/settings/rtc/route.ts`
- Create: `tests/desktop/configurable-model.test.mjs`
- Create: `tests/desktop/rtc-settings.test.mjs`

**Interfaces:**
- Produces: 任意 OpenAI 兼容模型设置和 DPAPI 加密的 RTC Token 设置。

- [ ] **Step 1: 写失败测试**

覆盖自定义 base URL/模型、模型为空校验、正式 Token 服务、试用 Token 到期、拒绝保存 AppKey 和响应中不回显密钥。

- [ ] **Step 2: 实现设置界面与 API**

正式模式字段为 AppID、Token 服务 URL、房间前缀和语言；试用模式额外接收临时 Token 与到期时间，显著显示试用警告。

- [ ] **Step 3: 验证并提交**

Run: `node --test tests/desktop/configurable-model.test.mjs tests/desktop/rtc-settings.test.mjs && npm run build`
Expected: PASS。

Run: `git add features/settings app/api/settings tests/desktop && git commit -m "feat: configure AI and RTC providers in client"`

### Task 6: 实时字幕、监听状态与人工介入

**Files:**
- Create: `features/subtitles/live-subtitles.tsx`
- Create: `features/intervention/intervention-state.ts`
- Create: `features/intervention/intervention-controls.tsx`
- Create: `desktop/audio/output-mixer.ts`
- Create: `tests/desktop/intervention-state.test.mjs`
- Create: `tests/desktop/output-mixer.test.mjs`
- Modify: `app/page.tsx`
- Modify: `features/readiness/interview-readiness.ts`

**Interfaces:**
- Produces: `beginIntervention()`、`endIntervention()`、`resumeAi()`、`emergencyMute()` 和实时字幕视图。

- [ ] **Step 1: 写状态失败测试**

覆盖按下即取消 AI/淡出 TTS、接通真实麦克风、松开后 AI 仍暂停、介入语音不送字幕、紧急静音停止所有输出。

- [ ] **Step 2: 实现互斥混音和控制状态机**

人工介入优先级高于 TTS；候选人捕获 PCM 只发 RTC，真实麦克风和 TTS 只发虚拟麦克风，三条路线不得交叉。

- [ ] **Step 3: 实现字幕和电平 UI**

显示识别中/已确认字幕、捕获/RTC/TTS/人工麦克风/虚拟输出五路电平，以及暂停、按住说话、全部静音和结束按钮。

- [ ] **Step 4: 验证并提交**

Run: `node --test tests/desktop/intervention-state.test.mjs tests/desktop/output-mixer.test.mjs && npm run test:readiness && npm run build`
Expected: PASS。

Run: `git add features/subtitles features/intervention desktop/audio app/page.tsx features/readiness tests/desktop && git commit -m "feat: add live subtitles and human intervention"`

### Task 7: 集成发布验收

**Files:**
- Modify: `docs/windows-client.md`
- Modify: `docs/release-checklist.md`
- Modify: `scripts/verify-release.ps1`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: Windows 桌面客户端主计划及本修订的全部产物。
- Produces: RTC 许可闸门、音频桥接验收和公开源码发布。

- [ ] **Step 1: 更新发布阻断条件**

校验脚本要求 RTC SDK 许可结论、SDK/sidecar 哈希、无 AppKey、无临时 Token、无原始 PCM 和无字幕数据后才允许打包。

- [ ] **Step 2: 执行自动化回归**

Run: `npm test && npm run build && npm run package:smoke && npm audit --audit-level=high`
Expected: 全部 PASS。

- [ ] **Step 3: 执行同机人工验收**

在至少两种会议软件验证按进程捕获、监听无双声、实时/最终字幕、AI 不回灌、按住说话、松开不自动恢复和紧急静音。

- [ ] **Step 4: 开源发布**

沿用 Windows 客户端主计划的 GitHub 建库与推送步骤。若 RTC SDK 不允许重分发或驱动/RTC 实机验收未通过，只公开源码和适配接口，不上传安装包。
