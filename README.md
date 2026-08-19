# AI虚拟助手

本地 **AI虚拟助手**：可用于面试官 / 候选人辅助、会议主持、虚拟直播互动等场景。

> 当前版本是 Windows x64 内部试用版。使用前须告知对方 AI 参与和记录方式，并由人工复核；不得用于隐蔽冒充或未经复核的自动决策。

- `/`：虚拟助手工作台；
- `/stage`：给 OBS 采集的助手舞台；
- Windows 内置中文 SAPI 生成本地语音，浏览器 Web Speech 作为兜底，不产生语音合成费用；
- 支持上传自己的 JPEG、PNG、WebP、MP4 或 WebM 助手出镜素材；
- 支持上传多份 PDF/Word 参考资料（可拖入文件夹），本场可勾选多份参与追问参考；
- OpenAI-compatible 文本模型只负责根据对方回答生成追问；
- 已问问题会进入提示词并在本地做近重复检测；重复时最多重试模型一次，
  仍重复则使用不同角度的本地兜底问题。
- OBS Virtual Camera 将舞台作为摄像头提供给腾讯会议、飞书、钉钉、Zoom、Teams 等软件。
- Windows 客户端内置官方 OBS 32.2.1，并由 Electron 主进程通过 OBS WebSocket 一键创建场景、浏览器源并启停虚拟摄像头。
- 控制台提供服务、模型、舞台、系统语音和画面素材五项自动自检。
- 可从任意会议窗口或整个屏幕采集系统音频，分段转写为对方回答。
- Windows 客户端通过统一字幕接口显示实时字幕；管理端可在火山云 RTC 与自建 LiveKit 之间切换线路，默认仍是火山 RTC。
- 按住说话可暂停 AI，并由 OBS 将本机默认麦克风切入同一虚拟麦克风线路。

Windows 客户端安装、接线和已知限制见 [docs/windows-client.md](docs/windows-client.md)。

独立的管理 API 在 [server/control-api](server/control-api/README.md)：它与本客户端分离，没有公开注册入口。管理员网页控制台在 [server/management-web](server/management-web/README.md)（`http://127.0.0.1:3001`），用于查看账户在线/当前线路，以及把 AI、RTC 配置写入数据库。自建 LiveKit 默认不启动；需要时在 `server/control-api` 执行 `docker compose --profile livekit up -d`，再用 `npm run test:livekit-smoke` / `npm run test:livekit-load` 做 1 路和 10 路纯音频检查。默认 `activeProvider` 仍是火山 RTC。

## 运行

```powershell
Copy-Item .env.example .env.local
# 编辑 .env.local，填写 API Key、Base URL 和模型名
npm install
npm run dev
```

打开：

- 工作台：`http://localhost:3000`
- 助手舞台：`http://localhost:3000/stage`
- 健康检查：`http://localhost:3000/api/health`

在设置页的助手形象中上传图片或待机视频。文件保存在本机
`data/avatar`，OBS 舞台会自动切换，无需重启；也可以点击“恢复默认头像”清除素材。

## 对方语音转写

工作台点击“开始听取对方”，选择会议窗口或整个屏幕，并勾选共享系统音频。
应用每 10 秒上传一个独立片段，转写文本会追加到对方回答框，人工确认后再生成追问。

支持两种后端：

- `TRANSCRIPTION_PROVIDER=openai`：调用 OpenAI-compatible `/audio/transcriptions`；
- `TRANSCRIPTION_PROVIDER=whisper-cpp`：调用本机 `whisper-server /inference`，无按分钟费用。

远程转写地址必须使用 HTTPS，本机 `localhost`/`127.0.0.1` 才允许 HTTP。转写地址与
模型地址不同时必须配置 `TRANSCRIPTION_API_KEY`，系统不会把模型密钥转发给另一个服务；
两者 Base URL 完全一致时才允许复用同一密钥。

使用本地方案时，`whisper-server` 需要以 `--convert` 启动以接收浏览器 WebM/Opus，
并要求系统可以调用 FFmpeg。浏览器建议使用最新版 Edge 或 Chrome。

Windows 可直接自动安装和启动：

```powershell
npm run setup:whisper
npm run start:whisper
```

安装脚本会从 whisper.cpp 最新官方 Release 下载 CPU x64 版本，下载并校验多语言
`base` 模型，在缺少 FFmpeg 时调用 winget 安装，并自动把 `.env.local` 切换为
`TRANSCRIPTION_PROVIDER=whisper-cpp`。

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

- `First-Time-Setup.cmd`：首次安装，会先选择最小安装、完整安装、本机离线安装或退出；
- `Check-AI-Virtual-Assistant.cmd`：只检查环境，不安装；
- `Start-AI-Virtual-Assistant.cmd`：日常启动并打开工作台。
  （旧名 `Check-AI-Interviewer.cmd` / `Start-AI-Interviewer.cmd` 仍可调用，会转发到新入口。）

源码启动的最小安装会安装项目依赖和系统 OBS、跳过 Whisper，可先人工输入对方回答；完整安装额外配置
本地 whisper.cpp；本机离线安装再额外安装 Ollama 并下载约 3.4GB 的 `qwen3.5:4b`，
完成后模型设置会自动指向本机。所有安装都必须先由用户在菜单中主动选择，且都不会自动
安装虚拟音频驱动。若电脑没有 Node.js 22.13.0+，安装器会在选定档位后通过 winget 的
`OpenJS.NodeJS.LTS` 精确包安装当前 Node LTS，再继续 npm 安装；已有兼容版本不会改动。

首次安装：

```powershell
npm run setup:windows
npm run check:environment
```

`setup:windows` 会安装 npm 依赖、通过 winget 安装 OBS，并复用官方 whisper.cpp
Release 完成本地转写配置。若已经自行安装某项，可直接运行
`scripts/setup-windows.ps1 -SkipObs` 或 `-SkipWhisper`。

日常使用：

```powershell
npm run start:windows
```

该命令会按配置启动 whisper-server、系统 OBS、Next.js，并打开工作台。这是源码脚本流程；
打包后的 Windows 客户端使用内置的专用 OBS，密码由 Electron `safeStorage` 以当前用户 DPAPI
保护主副本，并同步到专用 OBS 配置。密码不会进入 OBS 命令行、渲染页面、IPC 或日志。
OBS 上游必须读取明文配置，因此专用运行目录的 `obs-websocket\config.json` 中仍有明文密码；
该目录仅归当前 Windows 用户所有。详情见 [Windows 客户端使用说明](docs/windows-client.md)。
若源码流程中的系统 OBS 已提前启动，启动器会提示确认正常重启；取消或正常关闭失败时不会强制结束 OBS。日志保存在
`.tools/logs`。虚拟音频驱动涉及系统设备和重启，仍需按控制台指引由用户或 IT 明确安装。
启动器会等待 `/api/health` 返回本项目的固定服务标识后才打开浏览器；端口上的其他 HTTP
服务即使返回 200 也不会被误当成本项目。

日常启动使用生产模式，助手舞台不会出现 Next.js 开发工具图标。修改代码后先运行
`npm run build`；开发调试才使用 `npm run dev`。

控制台和舞台默认只监听 `127.0.0.1`，不会自动向局域网开放。开始互动前必须确认
已向对方说明 AI 协助、记录保存和人工复核；开场白也会再次说明。历史记录支持
逐条永久删除，删除前会要求确认。
所有修改型 API 还会校验浏览器 `Origin` 和 `Sec-Fetch-Site`，外部网页不能通过普通表单
替换本机助手素材或触发音频转写；本机命令行安装与检查脚本不受影响。
控制台、OBS 舞台和 API 统一返回 CSP、防嵌入、`nosniff`、无 Referrer 和浏览器能力限制
响应头；CSP 只允许同源资源、本机 OBS WebSocket，以及 VAD 所需的 WebAssembly/Blob。
页面不能被外部网站 iframe 嵌入诱导点击。

AI 模型可直接在控制台的“AI 模型设置”中配置，无需手改文件或重启。Windows 下
API 密钥使用当前用户的 DPAPI 加密，磁盘只保存密文，页面读取接口不会返回密钥。
若使用本机 Ollama、llama.cpp server 或 LocalAI，可填写其 `http://127.0.0.1:端口/v1`
地址并将密钥留空；无密钥模式只对本机回环地址开放。远程模型仍必须使用 HTTPS 和密钥。
把配置切换为本机回环地址并留空密钥时，会删除此前保存的远程密钥，避免将它发送给
本机模型进程。
AI 模型未配置时不能开始新互动；OBS 和自动转写未就绪时仍可先使用舞台预览与人工输入，
不会被错误当作模型必需项。

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
点击开始时还会通过 `GET /models` 做一次最多 5 秒的无推理检查；模型服务不可达或填写的
模型不存在时不会创建会话，也不会发送对方数据。
追问默认最多等待 60 秒，纪要最多等待 180 秒；可用
`MODEL_QUESTION_TIMEOUT_MS` 和 `MODEL_REPORT_TIMEOUT_MS` 调整，超时后可直接重试。
Windows SAPI 合成默认最多等待 30 秒、声音枚举最多 10 秒，超时会清理子进程；
可用 `SAPI_SYNTHESIS_TIMEOUT_MS` 和 `SAPI_VOICE_LIST_TIMEOUT_MS` 调整。

可选的一键本机模型（会安装 Ollama 并下载约 3.4GB 的 `qwen3.5:4b`，仅在你主动执行时发生）：

```powershell
npm run setup:ollama
```

只查看将执行什么、不安装或下载：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup-ollama.ps1 -DryRun
```
远程 OpenAI-compatible 地址必须使用 HTTPS；本机模型地址可以使用 HTTP。

使用结束后可停止本项目和本地转写服务：

```powershell
npm run stop:windows
```

默认不会关闭用户可能正在使用的 OBS；如需一并关闭，运行
`scripts/stop-windows.ps1 -IncludeObs`。

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
