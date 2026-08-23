# 桌面客户端 UI 改版与会议音频自动链路 · 设计文档

- 日期：2026-08-20
- 状态：已确认（用户选择方案 A：虚拟声卡桥接）
- 视觉基准：`videos/client-console-frame/`（HyperFrames 画面第六版，用户逐轮确认）

## 1. 目标

1. 桌面客户端界面与已定稿的画面排版对齐（角色下拉、中栏底部精简）。
2. 打通"自动捕获会议音频 → 实时转写字幕 → 自动作为对方回答提交 → AI 自动追问"的全自动链路，**采用虚拟声卡桥接（auto-bridge）方案**，不做窗口画面捕获。

## 2. 现状与差距

### 已具备（直接复用，零新依赖）

| 能力 | 位置 |
| --- | --- |
| 角色下拉（头像+用户名触发器、菜单、退出、底部资料行） | `features/settings/user-account-menu.tsx` |
| 会议进程自动识别 + 自动启动桥接（轮询状态机） | `features/rtc/auto-bridge-controller.tsx`、`auto-bridge-decision.ts`、`auto-bridge-store.ts` |
| 进程音频捕获 → PCM → RTC 房间 → 字幕事件 | `native/AudioBridge`（C# 侧载程序）、`features/rtc/bridge-session.ts` |
| 字幕汇聚与 final 事件 | `lib/subtitles/sink.ts`（`subscribeFinal`） |
| 实时字幕展示 | `features/subtitles/live-subtitles.tsx` |
| 人工介入（按住说话/恢复 AI/立即静音） | `features/intervention/intervention-controls.tsx` |
| AI 语音 → 虚拟声卡（VB-CABLE）→ 会议麦克风 | 现有 TTS 输出 + 启动时虚拟声卡自动检测/安装 |

### 差距（本次要做的）

1. **字幕→回答的自动提交未接通**：`subtitleSink.subscribeFinal` 目前只有测试在用；final 转写不会自动提交为对方回答。
2. **界面与定稿画面不一致**：角色下拉菜单项顺序/内容与画面不同；中栏底部还保留「对方回答」整块（开始/停止听取、状态条、自动回应勾选、转写输入框、生成追问按钮）。

## 3. 界面改版

### 3.1 角色下拉（`user-account-menu.tsx` + `app/styles.css`）

按画面第五/六版重排：

- 菜单项区（在上）：工作台（当前页高亮）→ 舞台（新窗口打开）→ 记录 → 设置（右侧带灰色 `Ctrl+,` 快捷键提示，与画面一致；Electron 内注册同名 accelerator，浏览器端仅展示）。移除现有的「会议接入（虚拟声卡）」项（功能已并入右栏会议接入卡片）。
- 分割线后：红色「退出登录」（现文案为「退出」，改为「退出登录」）。
- 底部资料行（在下）：用户名（粗体）+ 副标题「客户端账号」+ 右侧 ⚙ 齿轮链接到 `/settings`；**移除底部资料行的头像**（触发器里的头像保留，作为点击入口）。
- 触发器保持现状：首字母头像 + 用户名 + 下拉箭头。

### 3.2 中栏底部（`app/page.tsx`）

删除整个「对方回答」区块（现 L754–L812 的 captureBar、autoFollowup 勾选、聆听状态、无声告警、answer textarea + 生成追问按钮、divider），该卡片只保留：

```
AI 人工播报
[让虚拟助手直接说一句话 ______] [播报]
```

- 删除后 `capturingAudio`/`startAudioCapture`/`stopAudioCapture`（getDisplayMedia 采集链）从工作台主流程解绑：该链路保留代码不删（设置页/舞台可能仍用），仅移除中栏入口。
- 人工兜底保留：对话记录卡片上的「修正最近回答」「重生成本题」按钮不动。

### 3.3 其余栏位

- 右栏顺序不变：会议接入（MeetingBridgeCard，含会议软件选择 + 自动识别状态）→ 实时字幕 → 监听与人工介入。
- 左栏会话设置不动。
- 顶栏其他部分不动。

## 4. 自动链路接线（虚拟声卡桥接）

### 4.1 数据流

```
会议进程（腾讯会议等）
  └─ AudioBridge 侧载程序捕获进程音频（由 AutoBridgeController 自动识别并启动）
      └─ PCM → createPcmTrack → RTC 房间（火山云 RTC / 自建 LiveKit）
          └─ 云端转写 → subtitleSink.publish
              ├─ LiveSubtitles 实时展示（已有）
              └─ 【新增】subscribeFinal → 自动提交为对方回答 → AI 生成追问
AI 回应
  └─ TTS → 虚拟声卡（VB-CABLE）→ 会议软件麦克风输入 → 对方听见
```

### 4.2 新增模块：`features/rtc/auto-answer-submit.ts`

新增一个 React hook：`useAutoAnswerSubmit({ enabled, onAnswer })`

- 在 `app/page.tsx` 挂载，`enabled = automaticFollowup && session.status === "running" && !aiSpeaking`；`onAnswer(text)` 复用现有 `submitAnswer` 提交路径（与手填输入框走同一 action，带 expectedRevision 防抖）。
- 内部 `useEffect` 订阅 `subtitleSink.subscribeFinal`，收到 final 行时：
  - 过滤空文本与纯标点；
  - 过滤当前处于 AI 播报/回声保护窗口内的行（见 4.3）；
  - 调用 `onAnswer(line.text)`。

### 4.3 回声保护

- AudioBridge 捕获的是**会议进程播放的声音**：正常情况下只有对方语音。但 AI 的声音经虚拟声卡进入会议后，若对方设备/会议软件将 AI 语音回播放（如对方开扬声器且会议有回传），可能被再次捕获。
- 防线两条（都实现）：
  1. **时间窗**：`aiSpeaking`（AI 正在播报）及播报结束后 1.5 秒内的 final 行丢弃。复用页面现有播报状态（`busy` / TTS 播放事件）。
  2. **半双工**：`InterventionControls` 暂停 AI 时 `automaticFollowup` 已被置反；恢复 AI 后自动提交随之恢复（现成联动，不改）。

### 4.4 与「对方回答」区块删除的关系

- 原区块的「自动回应」勾选框职责迁移：`automaticFollowup` 默认 **on**，开关入口收敛到右栏「监听与人工介入」卡片（恢复 AI / 按住说话 即对应开/关），不再在中栏暴露。
- 原区块的手动转写输入职责由「实时字幕 + 自动提交」替代；人工纠错走「修正最近回答」。

## 5. 错误处理与降级

| 场景 | 行为 |
| --- | --- |
| 未检测到会议进程 | AutoBridgeController 现状：等待/退避，状态经 `ai-auto-bridge-status` 事件透出，会议接入卡片展示 |
| 桥接启动失败（Token、设备） | 现状错误提示保留；用户可手动在会议接入卡片重试 |
| 转写服务未配置 | final 事件不产生，自动提交静默不触发；字幕卡片展示空态 |
| AI 播报中 | final 行被丢弃（4.3），不会自我追问 |

## 6. 测试与验收

1. `npm run build` + 桌面端类型检查（`tsconfig.desktop.json`）通过。
2. 新增 `scripts/test-auto-answer-submit.mjs`：对 hook 的核心过滤逻辑（空文本、AI 播报窗口、正常提交）做单元级冒烟（纯函数部分抽出测试，参照 `tests/desktop/subtitle-merge.test.mjs` 风格）。
3. 手动冒烟（交付说明中列出步骤）：启动客户端 → 开启腾讯会议 → 观察自动识别与字幕 → 对方说话停顿后 AI 自动追问。

## 7. 依赖与开源合规（AGENTS.md）

- **零新增依赖**：全部复用项目现有能力（@volcengine/rtc、livekit、AudioBridge、VB-CABLE 自动安装均为既有）。
- 在 `docs/dependency-decisions.md` 追加一条记录：本次改版无新增依赖，说明复用清单。

## 8. 明确不做（YAGNI）

- 不做会议画面捕获/劫持（用户已明确暂缓）。
- 不新增账户套餐体系（资料行副标题沿用「客户端账号」）。
- 不改动左栏会话设置与舞台页。
