# AI虚拟助手

本地 **AI虚拟助手**：可用于面试官 / 候选人辅助、会议主持、虚拟直播互动等场景。

## Tauri 实验性基础

日常产品路径是 `npm run tauri:dev` / Tauri Direct Runtime：本机 Rust Runtime 执行
转写、Realtime 与会话命令。Python LiveKit Agent 与 `docker compose --profile livekit`
仅为遗留实验，默认不启动。Electron / Next.js 仍留在仓库，但不是日常产品入口。

开发 Tauri 基础需要 Windows、Rust 1.96、Node.js 24 和 Microsoft Edge WebView2 Runtime：

```powershell
npm install
npm run tauri:dev
```

验证与打包：

```powershell
npm run test:tauri
npm run tauri:build
npm run test:tauri-package
```

打包冒烟测试会在隔离的临时配置目录中启动成品，等待最多 15 秒确认主窗口可见，检查其
进程树没有 Node、Control API、Python、PostgreSQL 或 Nginx，并确认安装包目录未混入本地
配置、数据库、日志或凭据测试文件。

### Tauri Page Shell (Phase 2)

The Tauri client now provides five read-only page shells with sidebar navigation:

- **工作台** (Workspace) — Design §6.1
- **资料** (Materials) — Design §6.2
- **记录** (Records) — Design §6.3
- **服务** (Services) — Design §6.4
- **设置与诊断** (Settings & Diagnostics) — Design §6.5

Pages display migration roadmaps and capability placeholders. Business commands are not yet wired — they will be connected in subsequent phases.

Launch with `npm run tauri:dev` (development) or `npm run tauri:build` (packaging).

Electron/Next.js remains in the tree as leftover packaging; it is not the daily product path.

> 当前版本是 Windows x64 内部试用版。使用前须告知对方 AI 参与和记录方式，并由人工复核；不得用于隐蔽冒充或未经复核的自动决策。

- `/`：虚拟助手工作台；
- `/stage`：给 OBS 采集的助手舞台；
- 支持上传自己的 JPEG、PNG、WebP、MP4 或 WebM 助手出镜素材；
- 支持上传多份 PDF/Word 参考资料（可拖入文件夹），本场可勾选多份参与追问参考；
- 日常路径下，追问、转写和播报由 Tauri Direct Runtime 在本机执行；Python LiveKit Agent 仅为遗留实验。
- OBS Virtual Camera 将舞台作为摄像头提供给腾讯会议、飞书、钉钉、Zoom、Teams 等软件。
- Windows 客户端内置官方 OBS 32.2.1，并由 Electron 主进程通过 OBS WebSocket 一键创建场景、浏览器源并启停虚拟摄像头。
- 日常路径下会议音频由 Tauri Direct Runtime 转写；遗留 Electron 路径才经桌面桥接进入 LiveKit 并由 Python Agent 回复。
- Windows 客户端通过统一字幕接口显示实时字幕；**实时会议字幕 / RTC 仅走自建 LiveKit**（火山 RTC 已下线）。
- 日常路径下，ASR/LLM/TTS/Realtime 由 Tauri Direct Runtime 执行，凭据只走 Windows 凭据保管。Python LiveKit Agent 不再是默认或唯一执行端。
- 按住说话可暂停 AI，并由 OBS 将本机默认麦克风切入同一虚拟麦克风线路。

Windows 客户端安装、接线、OBS/VB-CABLE 与已知限制见下方「OBS 设置」「Windows 快速启动」章节。

Python LiveKit Agent、Go Control API、管理员控制台和 nginx 部署树已从产品中移除，不再随仓库提供。

## 运行

```powershell
npm install
npm run tauri:dev
```

在设置页的助手形象中上传图片或待机视频。文件保存在本机
`data/avatar`，OBS 舞台会自动切换，无需重启；也可以点击“恢复默认头像”清除素材。

## 对方语音转写

日常产品路径由 Tauri Direct Runtime 在本机执行转写与回复，不启动 Python Agent。
以下描述的是遗留 Electron + LiveKit Agent 实验室路径（需 `docker compose --profile livekit`）：

会议音频由桌面桥接发布到 LiveKit 房间，遗留 **LiveKit Agent** 可按当时启用的语音线路执行转写与回复：

- 级联线路：房间 PCM → ASR → 带会话上下文的 LLM → TTS → 再发布回房间；
- 端到端线路：房间 PCM 进入 Realtime WebSocket（含阿里云 Qwen Audio Realtime），返回音频与字幕。

客户端不再调用 `/api/transcribe`，也不再本机配置 Whisper / 模型密钥。字幕与回复走 LiveKit 数据通道；重试、修正、人工说话和纪要走 `agent.command.v1`。

## OBS 设置

1. 安装 Windows 客户端；OBS Studio 32.2.1 已随安装包提供，无需另装 OBS。
2. 正式安装器会请求管理员授权注册 `OBS Virtual Camera`。直接运行 `dist\win-unpacked` 预览版时，若页面显示“需要授权”，点击“管理员授权注册并连接”。
3. 关闭用户自行打开的 OBS，再在客户端点击自动连接；客户端只启动和管理自身专用运行目录中的 OBS，不会结束用户的 OBS。
4. 自动连接会创建或更新 `AI Digital Human` 场景和浏览器源，
   设置 1280×720 并启动 Virtual Camera。
5. 在线上会议中将摄像头选择为 `OBS Virtual Camera`。
6. 在控制台“会议摄像头最终预览”点击检测，授权摄像头后确认能看到助手画面；
   检查完成后点击停止预览释放设备。
7. 回到控制台查看“OBS 输出自检”，点击“播放测试语音”确认 OBS 音量表有波动。
8. 若舞台提示“点击启用声音并重播”，在 OBS 中右键舞台源选择“交互”，点击一次该按钮；这是 Chromium 自动播放策略的首次授权。

会议软件通常不会把 OBS Virtual Camera 的声音当作麦克风。客户端内置官方
[VB-CABLE](https://vb-audio.com/Cable/)（Donationware，来源 www.vb-cable.com，欢迎捐赠）：
设置页「一键授权并检测」会提权安装；安装后若设备未出现需重启一次。
会议麦克风选择 `CABLE Output`；AI 语音播放到 `CABLE Input`
（中文系统可能显示 `CABLE In 16 Ch` 或 `扬声器 (VB-Audio Virtual Cable)`）。
OBS 自动配置会将舞台源设为“仅监听”；使用 OBS 监听时同样选择该播放端。

## Windows 快速启动

不想使用命令行时，可以直接双击：

- `First-Time-Setup.cmd`：首次安装，可确认安装或直接退出；
- `Check-AI-Virtual-Assistant.cmd`：只检查环境，不安装；
- `Start-AI-Virtual-Assistant.cmd`：日常启动并打开工作台。
  （旧名 `Check-AI-Interviewer.cmd` / `Start-AI-Interviewer.cmd` 仍可调用，会转发到新入口。）

源码安装会安装项目依赖和系统 OBS，但不会安装本地模型或转写服务，也不会自动安装
虚拟音频驱动。若电脑没有 Node.js 22.13.0+，安装器会在用户确认后通过 winget 的
`OpenJS.NodeJS.LTS` 精确包安装当前 Node LTS，再继续 npm 安装；已有兼容版本不会改动。

首次安装：

```powershell
npm install
```

若尚未安装 OBS，可运行 `scripts/setup-windows.ps1`；已自行安装时可加 `-SkipObs`。

日常使用：

```powershell
npm run tauri:dev
```

Electron / Next.js 启动路径已移除。打包用 `npm run tauri:build`。
打包后的 Windows 客户端使用内置的专用 OBS，密码由当前用户 DPAPI
保护主副本，并同步到专用 OBS 配置。密码不会进入 OBS 命令行、渲染页面、IPC 或日志。
OBS 上游必须读取明文配置，因此专用运行目录的 `obs-websocket\config.json` 中仍有明文密码；
该目录仅归当前 Windows 用户所有。更多 OBS / 虚拟声卡接线见下方「OBS 设置」章节。
若源码流程中的系统 OBS 已提前启动，启动器会提示确认正常重启；取消或正常关闭失败时不会强制结束 OBS。日志保存在
`.tools/logs`。虚拟音频驱动涉及系统设备和重启，仍需按控制台指引由用户或 IT 明确安装。

控制台和舞台默认只监听 `127.0.0.1`，不会自动向局域网开放。开始互动前必须确认
已向对方说明 AI 协助、记录保存和人工复核；开场白也会再次说明。历史记录支持
逐条永久删除，删除前会要求确认。
所有修改型 API 还会校验浏览器 `Origin` 和 `Sec-Fetch-Site`，外部网页不能通过普通表单
替换本机助手素材或触发客户端操作；本机命令行安装与检查脚本不受影响。
控制台、OBS 舞台和 API 统一返回 CSP、防嵌入、`nosniff`、无 Referrer 和浏览器能力限制
响应头；CSP 只允许同源资源、本机 OBS WebSocket，以及 VAD 所需的 WebAssembly/Blob。
页面不能被外部网站 iframe 嵌入诱导点击。

日常产品路径由 Tauri Direct Runtime 本机执行模型调用，凭据只走 Windows 凭据保管。
以下 Electron / 管理端路径仍把密钥留在服务端；遗留 Python LiveKit Agent 仅在显式
`--profile livekit` 时读取语音线路快照，默认不会启动。

本机设置、当前会话、历史记录和头像元数据统一保存在 `data/app.sqlite`。SQLite 使用 WAL
和事务保证整轮写入；头像图片或视频本体仍保存在 `data/avatar/media`。升级旧版本时会
自动导入原有 JSON 和 `.tools` 中的 OBS 密文，成功后旧文件仅作为恢复备份保留，不再写入。
正式开始前还必须通过输出门禁：舞台和素材在线、中文语音可用、OBS 已连接并启动
Virtual Camera、最终摄像头画面预览通过且虚拟麦克风线路已检测。预览确认后可以停止预览
释放摄像头，再进入对方选择的会议软件；在入会预览中选择 `OBS Virtual Camera` 和
检测通过的虚拟麦克风、确认画面与音量后，还需在控制台确认本场软件的“最后一跳”。
若 OBS 虚拟摄像头停止或设备线路失效，会议软件确认会一并自动失效。
中文语音也必须点击“播放测试语音”并由舞台完整播放成功后才通过，不能只凭系统安装了
中文声音包放行；这段测试不会写入互动记录。
摄像头或音频设备列表发生变化时原验证会立即失效；即使浏览器不支持设备变化事件，
验证也会在 5 分钟后过期，避免沿用过时的设备状态。
虚拟音频门禁只认可 VB-CABLE、Virtual-Audio-Driver 或 Voicemeeter 的完整输入/输出配对；
ToDesk 等远控软件的音频端点会显示提示，但不会被误认为通用会议回传线路。
识别到配对后还会让舞台播放测试语音，并直接读取对应虚拟麦克风的本地音量；只有实际
检测到信号才通过，因此 OBS 监听设备或“仅监听”设置错误时不会误显示为就绪。
Windows SAPI 合成默认最多等待 30 秒、声音枚举最多 10 秒，超时会清理子进程；
可用 `SAPI_SYNTHESIS_TIMEOUT_MS` 和 `SAPI_VOICE_LIST_TIMEOUT_MS` 调整。

## 当前限制

- 当前采用轻量 2D 助手出镜，不需要独立显卡。
- 对方语音可从会议窗口或整个屏幕采集和转写，提交追问前仍允许人工校对。
- 当前单人会话和历史归档通过事务保存到 `data/app.sqlite`，控制台仍可导出完整 JSON。
- 如果当前会话载荷意外损坏，系统会把原始载荷移入 SQLite 隔离表，再恢复最新一份
  结构有效的归档，避免静默覆盖恢复线索。
- 互动进行中不能直接创建新会话；必须先结束并归档当前会话，防止记录被覆盖。
- 每次回答都绑定当前会话版本；回答和下一问（或结束语）会整轮原子保存。
  并发重复提交会返回冲突，模型失败不会留下半轮记录。
- 当前会话和历史记录同时支持 JSON 原始数据与 Markdown 人类可读记录下载；
  Markdown 包含对话、证据纪要和强制人工复核声明。
- 可填写补充说明、对话重点和问题上限；达到上限后自动播放结束语。
- AI 追问不合适时可点击“重生成本题”，原位替换问题，不重复对方回答或增加题数；
  人工播报仅在互动进行中可用。
- AI 追问只允许围绕主题能力和明确经历；年龄、婚育家庭、宗教政治、民族籍贯、
  健康病史、残障、性别或性取向等个人敏感问题会在本地拦截并重试，仍不合适则改用
  安全的主题问题。该技术约束不替代企业法律与合规复核。
- 对方回答以有长度预算的 JSON 数据发送给模型，系统提示明确禁止执行回答中的命令、
  角色声明或规则修改要求；对话不会通过截断半个 JSON 对象来控制长度。
- 人工接管播报和结束语不计入问题上限；“重生成本题”绑定当前会话版本，
  生成期间若轮次改变，旧结果不会覆盖新问题。
- 自动转写有误时可点击“修正最近回答”；只有模型成功生成匹配的新追问后，
  回答和当前问题才会一起原子更新，失败不会留下半轮记录。
- 可选开源 Silero VAD 自动模式：对方停止说话约 2.5 秒后自动转写并追问；
  VAD 模型和 WASM 随本地项目提供，不依赖运行时 CDN。
- 自动追问采用半双工防回声：AI 播报期间暂停 VAD，舞台确认播放结束后恢复，
  防止把助手自己的声音再次识别为对方回答。
- 排队转写会绑定捕获时的题目版本；若处理完成前已经进入下一题，该段文本会转入
  人工输入框等待确认，不会被错误自动提交到新问题下。
- 结束后的会话会自动归档，可从历史列表导出；可生成证据型 AI 纪要。
  纪要不提供录用建议、排名或总分，模型引文必须能在原始回答中逐字核验，
  最终结论必须由人工复核。
- 正式使用前应告知对方正在与 AI虚拟助手交互，并提供人工接管方式。
