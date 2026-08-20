# 开源与依赖决策记录

每项新功能实施前，在此追加一条记录。

## 虚拟声卡改用官方 VB-CABLE Pack45

- 目标：在 Windows 11 内存完整性 / VBS 开启时，把 AI TTS 送到腾讯会议、飞书、Zoom 等会议麦克风。
- 原因：已签名 [Virtual-Audio-Driver 25.7.14](https://github.com/VirtualDrivers/Virtual-Audio-Driver)（SignPath Foundation）Authenticode 有效，但 HVCI 以问题码 52（`CM_PROB_UNSIGNED_DRIVER` / `0xC0000428`）拒绝内核镜像，设备节点无法 Started。上游卡在微软 attestation（[issue #15](https://github.com/VirtualDrivers/Virtual-Audio-Driver/issues/15)）。应用不得关闭内存完整性或启用测试签名。同机 ToDesk 虚拟音频可用，是因为它通过了 Microsoft attestation。
- 采用：官方 [VB-CABLE Pack45](https://vb-audio.com/Cable/) Donationware Simple。用户已授权随包分发（[VB-Audio licensing](https://vb-audio.com/Services/licensing.htm)）：标明来源 `www.vb-cable.com`、欢迎捐赠；不捆绑 A+B / C+D。钉死 `VBCABLE_Driver_Pack45.zip` SHA-256 `B950E39F01AF1D04EA623C8F6D8EB9B6EA5C477C637295FABF20631C85116BFB`，Setup 发布者 `BUREL VINCENT Entrepreneur individuel`。zip 与 OBS 一样 gitignore，不提交。无新增 npm 依赖。
- 安装：提权运行解压目录中的 `VBCABLE_Setup_x64.exe -i -h`（失败则可见窗口 `-i`）。已出现成对 CABLE 端点，或驱动库已有 `vbaudio_cable` / `vbMmeCable` 时跳过 Setup（再跑会进入卸载）。卸载本应用时不卸载 VB-CABLE。遗留 `ROOT\VIRTUALAUDIODRIVER` 问题码 52 不得判失败、不得再一键安装该节点。
- 检测：`virtualAudioInstalled` 认成对端点：录音端 `CABLE Output` 或 `麦克风 (…VB-Audio…)`，播放端 `CABLE Input` / `CABLE In 16 Ch` 或 `扬声器 (…VB-Audio…)`；兼容已有 Voicemeeter 成对设备，以及仍能 Started 的遗留开源驱动。设备已出现即成功，不再要求重启；仅当安装后成对端点仍未出现时才提示重启。
- 会议用法：会议麦克风选 `CABLE Output`；AI 语音 `setSinkId` 到播放端（英文系统 `CABLE Input`，中文系统常显示 `CABLE In 16 Ch` 或 `扬声器 (VB-Audio Virtual Cable)`）。
- 授权与捐赠：VB-CABLE 为 Donationware，来源 `www.vb-cable.com`，欢迎向 VB-Audio 捐赠；说明只写在本文档与 README，设置页不堆授权文案。
- 限制：仍需一次 UAC；安装后若设备未出现需重启；捐赠软件非开源；不关闭 VBS。

## 虚拟声卡安装冒烟与失败详情

- 目标：不再靠设置页反复点按钮；用与 Electron 相同的 `installPrerequisite` 入口冒烟，直到 `ROOT\VirtualAudioDriver` 处于 Started，并把失败原文留在页面和日志里。
- 采用：`scripts/smoke-virtual-audio-install.mjs` 调用现有 `desktop/prerequisites/windows-install.ts`。官方 `pnputil` 仍不能创建设备节点，继续用系统 `setupapi.dll` / `newdev.dll`，不打包 WDK `devgen`。安装前清未 Started 的幽灵 ROOT 节点；驱动库已有或 pnputil 报「已存在/冲突」时继续绑定。失败始终输出一行 JSON，并写入 `%APPDATA%/AI Virtual Assistant/logs/`。
- 限制：冒烟和一键安装仍需一次 UAC。官方 `pnputil` 没有 `/add-device`，不打包 WDK `devgen`。Windows 11 在 VBS/内存完整性强制下会以问题代码 52（`CM_PROB_UNSIGNED_DRIVER` / `0xC0000428`）拒绝 SignPath 内核镜像，即使 Authenticode 有效；设备节点可以创建，但不能进入 Started。此时 JSON/`signature-rejected` 会写明关闭“核心隔离 > 内存完整性”并重启，而不是笼统的「系统组件处理过程中发生异常」。`Status: Problem` 不得被误判为 Started。

## 虚拟声卡 ROOT 设备创建与重启误判修复

- 目标：一键安装不再把「驱动已进库、设备未出现」误报成必须重启；重启后也不再因本地 INF 缺失而重新下载。
- 采用：继续使用已签名 [Virtual-Audio-Driver 25.7.14](https://github.com/VirtualDrivers/Virtual-Audio-Driver)（MIT/MS-PL，硬件 ID `ROOT\VirtualAudioDriver`）。微软对 `devcon install` 的替代是 WDK `devgen`，用户机没有该工具，因此在现有提权 `install-prerequisite.ps1` 中用系统自带 `setupapi.dll` / `newdev.dll` 注册 ROOT 设备，再用 `pnputil /add-driver /install` 绑定。提权进程用同一脚本的 `-Worker` 入口（短命令行），不再把整段脚本放进 `-EncodedCommand`，避免超过 Windows 32767 上限导致 UAC 后安装静默失败。不引入新 npm 依赖，不打包 WDK/devcon。
- 检测：`virtualAudioInstalled` 认 `ROOT\VIRTUALAUDIODRIVER` 实例及 Media/AudioEndpoint 名称；`virtualAudioPresentInDriverStore` 为真时跳过下载。`rebootRequired` 只来自 pnputil/`UpdateDriverForPlugAndPlayDevices` 的明确重启标志，且设备仍未 Started。
- 限制：安装仍需一次 UAC；仅 Windows 明确要求时才重启；会议软件仍需手动选择虚拟麦克风。

## 项目托管虚拟声卡一键下载

- 目标：设置页「一键授权并检测」不再把「Windows 驱动库为空」误报成安装包缺文件；源码/预览客户端可把官方签名驱动拉进项目托管目录后提权安装，用户不用另找安装包或改路径。
- 采用：继续使用 [Virtual-Audio-Driver 25.7.14](https://github.com/VirtualDrivers/Virtual-Audio-Driver) 官方签名 zip（MIT/MS-PL，发布者 SignPath Foundation）。复用现有 `scripts/fetch-prerequisites.ps1`（新增 `-Component virtual-audio`）、`install-prerequisite.ps1` / `pnputil` 与 SHA-256 钉死值，不新增 npm 依赖，也不把大体积 zip 提交进 git。
- 托管目录：源码/`npx electron .` 使用 `resources/prerequisites/virtual-audio-driver`；打包客户端优先 `process.resourcesPath/prerequisites`，资源目录不可写时下载到 `userData/prerequisites`。`virtualAudioDriverStaged` 只认目录中的 `VirtualAudioDriver.inf` + `.cat` + `.sys`；设备是否出现仍看 `pnputil /enum-devices`；驱动库有条目但设备未出现仍标等待重启。
- 限制：安装仍需 UAC；部分环境需重启 Windows；会议软件仍需手动选择虚拟麦克风。下载依赖 GitHub 可达。

## 虚拟声卡一键安装与声音刻录启用

- 目标：设置页「一键授权并检测」能补装已签名 Virtual Audio Driver，真实摄像头模式不依赖 OBS 即可把 AI 语音送进会议麦克风；声音刻录成功后回传音色 ID、绑定当前登录账号并启用该音色播报。
- 采用：继续复用 Virtual-Audio-Driver 25.7.14（MIT/MS-PL）与现有 `installPrerequisite` / `pnputil`；环回路测和舞台播报复用浏览器 `HTMLAudioElement.setSinkId`（人工接管已使用）；豆包 OpenSpeech `voice_clone` + 现有 `user_speech_voices` 账号绑定。不新增依赖。
- 检测：兼容中文/括号设备名；播放端标签被 Chromium 隐藏时先认虚拟麦克风，再用 `setSinkId` / `selectAudioOutput` 配对，不把成对失败当成驱动未装。
- 刻录：克隆请求带上与 TTS 相同的 `X-Api-Resource-Id`；解析嵌套 `speaker_id`/`custom_speaker_id`；业务错误不得回退成 `custom_zh_interviewer`。账号已绑定 `S_*` 等音色且豆包密钥可用时，TTS 走豆包该 ID，不被阿里云 `xiaoyun` 覆盖。
- 限制：驱动安装仍需 UAC；可能要重启 Windows；会议软件仍需手动选择虚拟麦克风。

## 工作台精简与对方声音本机监听

- 目标：工作台去掉与右上角重复的资料上传块，以及占位大的会议接入/音频桥接整卡；接入失败时仅提示。操作者需本机听到对方，才能决定是否打断 AI。
- 采用：复用现有 `UploadMaterialsDock`、设置页 `AudioRouteControl`/`MeetingHandoffControl`、Web Audio `AudioContext`/`HTMLAudioElement` 与 `localStorage`；不新增依赖。
- UI：会议接入与 RTC 桥接只留在 `/settings`；工作台失败/未就绪提示改为右上角固定悬浮 toast（可关闭），不占用页面顶部版面。
- 监听：`features/audio/remote-monitor.ts` 默认开启；屏幕共享采集与 RTC PCM 均可本机播放；关闭可避免与会议软件双声。
- 限制：进程捕获开启本机播放时，若会议软件本机也在出声可能双声，需用户按场景关开关。

## 真实摄像头与虚拟声卡解耦

- 目标：会议画面用真实摄像头时，仍可配置虚拟声卡把 AI 语音送进会议，并保留 AI 对话能力。
- 采用：复用现有 `AudioRouteControl` / `MeetingHandoffControl`；`outputMode` 只约束 OBS/虚拟摄像头门禁与形象素材。
- 门禁：真实模式开始互动仍只要求 AI 模型已配置；虚拟声卡可选。虚拟画面模式仍要求 OBS、虚拟摄像头、虚拟声卡与入会确认。
- 快照：`virtualCameraActive` 失效只清 `virtualCameraVerified`，不再清掉 `virtualAudioReady`。
- UI：设置页在真实模式下也展示虚拟声卡检测与入会确认；入会确认文案按 `real` / `virtual` 切换。工作台不再常驻接入整卡。
- 限制：TTS 仍由 `/stage` 播报；真实模式测线路需打开助手舞台，并将系统/混音输出接到虚拟线路线。

## 角位 chrome 与会议接入可见性

- 目标：登录与账户入口放到左下角（Cursor 式个人菜单），资料上传放到工作台右上角；解决默认真实摄像头模式下「虚拟声卡接入会议」看起来消失的问题。
- 采用：复用现有 `readControlSession`、`ResumeUpload`、`AudioRouteControl`、`MeetingHandoffControl` 与 readiness sessionStorage，不新增 UI 依赖。
- 布局：`AppChrome` 固定挂载左下 `UserAccountMenu`；工作台另挂右上 `UploadMaterialsDock`；顶栏不再横排设置/登录。
- 会议：虚拟声卡检测与入会确认在设置页完成；工作台仅在未就绪/接入异常时提示（见「工作台精简与对方声音本机监听」）。
- 边界：安装组件卡仍暂不展示。

## 桌面工作台、设置与记录页面拆分

- 目标：让 Electron 默认页只承担数字人实时互动，把技术配置、设备检测、历史记录和纪要移到独立页面。
- 采用：复用 Next.js App Router、现有 React 组件和浏览器 `sessionStorage`，不新增路由、状态管理或 UI 依赖。
- 桌面边界：实时字幕和人工介入保留在工作台；会议音频桥接、AI/RTC 凭据、OBS、数字人素材与输出检测进入设置页；安装组件卡暂不展示。
- 状态：会话存储只保存设备检测成功时间，不保存密钥、媒体流或对话数据；五分钟过期并在设备变化时级联失效。
- 兼容：服务端 API、IPC 名称、会话和归档结构保持不变，旧记录无需迁移。
- 补充：账户/设置入口在左下个人菜单；会议接入与 RTC 桥接见「工作台精简与对方声音本机监听」。

## 虚拟摄像头输出

- 目标：让数字人画面作为系统摄像头提供给不同线上会议软件。
- 采用：[OBS Studio](https://github.com/obsproject/obs-studio) 的 Virtual Camera。
- 许可证：GPL-2.0-or-later。
- 原因：成熟、跨平台，并以系统摄像头设备形式兼容多数会议软件；无需自行开发和签名虚拟摄像头驱动。
- 接入方式：OBS 浏览器源加载项目的 `/stage` 页面，再启动 Virtual Camera。
- 限制：视频和麦克风是两条设备线路，声音需通过 OBS 音频监控和虚拟音频设备接入会议软件。

## 单人数字人舞台

- 目标：在有限预算和普通电脑上提供可被 OBS 采集的面试官画面。
- 当前采用：Windows 内置 SAPI (`System.Speech`) 服务端生成 WAV、浏览器原生 `<audio>` 播放、Web Speech 失败兜底、CSS 轻量头像和 Next.js 页面。
- 语音调研：OBS Browser Source 基于 CEF，官方说明可访问现代 Web API，现有 `reroute_audio` 可把页面声音送入 OBS。普通浏览器实测后台舞台直接调用 SpeechSynthesis 会返回 `not-allowed`，因此不再把它作为唯一输出。
- SAPI 方案：Windows 当前用户已安装的中文 SAPI 声音由 PowerShell `System.Speech` 生成临时 WAV；文本经标准输入传递，不进入命令行，临时文件读取后立即删除。Windows PowerShell 5.1 的重定向输入默认可能是 GB2312，脚本显式使用无 BOM UTF-8 并有中文回环测试；服务端使用全局 Promise 队列串行合成，避免连续请求同时启动多个 SAPI 进程。复用系统组件，不增加包、模型或按次费用。
- 进程恢复：SAPI 合成默认限制 30 秒、声音枚举限制 10 秒；超时会终止精确的 PowerShell 子进程、清理临时 WAV，并让全局队列继续处理后续请求。可用 `SAPI_SYNTHESIS_TIMEOUT_MS` 和 `SAPI_VOICE_LIST_TIMEOUT_MS` 调整，不引入进程管理依赖。
- 系统兼容兜底：部分 Windows 环境中 `.NET System.Speech.GetInstalledVoices()` 会在已安装声音仍可用时抛空引用。脚本优先使用原路径，失败或未找到中文声音时切换到同为 Windows 内置的 `SAPI.SpVoice`/`SAPI.SpFileStream` COM 接口；不下载新语音模型，也不改变数据出机边界。
- 本地神经语音兜底：[OHF-Voice/Piper](https://github.com/OHF-Voice/piper1-gpl) 支持中文模型和 HTTP 服务，但当前主线采用 GPL-3.0 且需要 Python；旧 MIT Windows 二进制仓库已归档。第一版不默认捆绑，只有目标电脑没有可用中文系统声音时再作为可选安装项评估。
- 可观测性：舞台优先播放 SAPI WAV，失败才尝试 Web Speech，并持续报告声音数量、播放中/成功/失败状态、最近成功时间和两级错误代码；新语音使用递增令牌隔离旧事件，防止前一次回调覆盖当前说话状态。
- 就绪判定：健康接口和 `check:environment` 直接枚举启用的 `zh-CN` SAPI 声音；控制台优先显示该主线路数量，只有 SAPI 不可用时才把舞台 Web Speech 作为兜底，避免以浏览器声音误报 SAPI 已就绪。
- 现有重型方案：[MuseTalk](https://github.com/TMElyralab/MuseTalk)、[AvatarAI](https://github.com/PunithVT/ai-avatar-system)。
- 暂不采用原因：实时写实口型通常需要较强 GPU、模型权重和更复杂部署；第一版优先验证会议链路。
- 后续替换点：保持 `/stage` 输出不变，将头像渲染层替换为 MuseTalk 或其他经过许可证审查的数字人服务。

## AI 追问

- 目标：根据候选人上一轮回答生成一个后续问题。
- 采用：OpenAI-compatible Chat Completions HTTP 接口。
- 依赖：项目现有 `fetch` 和 `zod`，不增加额外模型 SDK。
- 原因：兼容多个模型服务，依赖较少，API Key 仅在服务端读取。
- 本机无密钥模式：Ollama、llama.cpp server 和 LocalAI 均提供 OpenAI-compatible 接口，核心项目为 MIT。继续使用现有 `fetch`，不引入各自 SDK；仅 `localhost`、`127.0.0.1`、`::1` 允许无 API Key，且请求不会发送空的 `Authorization` 头。远程地址仍必须使用 HTTPS 和密钥。
- 密钥切换边界：保存本机回环地址且不提供新密钥时，主动清除此前 DPAPI 保存的远程密钥；`setup-ollama.ps1` 写入本机配置时同样固定为 `null`。这样本机模型服务不会收到无关的远程凭据。若用户确实为本机兼容服务配置了鉴权，仍可在保存时显式提供新密钥。
- 连接测试：复用 OpenAI-compatible `GET /models`，设置 5 秒超时并检查所填模型 ID 是否存在；不发送聊天内容、不触发模型推理，也不增加 SDK。结果区分“不可达”“服务可达但模型名缺失”和“模型可用”。
- 开场门禁：模型是自动追问的必需能力。控制台健康状态未配置时禁用开始按钮，服务端 `start` 也复用 `getModelRuntimeConfig`/`isModelRuntimeConfigured` 返回 503，避免绕过界面后创建无法继续的活动会话。OBS、转写仍保留人工配置和输入兜底，不作为硬门禁。
- 开场实测：配置存在后，`start` 继续复用已有 `probeConfiguredModel`，以 5 秒上限调用 OpenAI-compatible `GET /models`；不可达返回 `MODEL_UNREACHABLE/503`，服务可达但目标模型缺失返回 `MODEL_NOT_FOUND/409`。探测不发送候选人内容、不触发推理，也不新增 SDK 或费用。
- Ollama 自动化：Windows 官方推荐原生安装，winget 当前提供精确包 `Ollama.Ollama`；脚本使用 winget exact ID，不执行远程 `irm | iex`。默认 `qwen3.5:4b` 在 Ollama registry 约 3.4GB，Qwen 权重为 Apache-2.0，兼顾中文能力与普通电脑资源。安装和模型下载只在用户主动运行 `npm run setup:ollama` 后发生；`-DryRun -Json` 可无副作用审计计划。
- 思考输出控制：Ollama 的 OpenAI-compatible 接口对 Qwen3.5 等思考模型支持 `reasoning_effort: "none"`；追问和纪要优先发送该参数。若其他兼容服务明确返回 400，则仅回退掉这个可选参数。进入字幕、语音和 JSON 解析前还会移除 `<think>`/`<reasoning>`、Markdown 与多余问题，并把追问限制为一个不超过 80 字的问题，避免内部推理被播放。复用现有 `fetch` 和字符串处理，不增加依赖。
- 重复问题保护：将已问问题显式放入提示词；本地再以 Unicode 字母数字归一化、包含比例和中文二元组 Jaccard 检测近重复。命中时只额外请求模型一次，仍重复则从本地不同追问角度中选择未重复项，避免有限题数被浪费且不会无限增加模型调用。
- 超时恢复：复用 Node 20 原生 `AbortSignal.timeout`，追问默认 60 秒、纪要默认 180 秒，可通过环境变量调整并限制在 1 秒到 10 分钟。超时统一映射为 `MODEL_TIMEOUT`/HTTP 504；生成成功前不修改需替换的问题或纠错内容，不引入超时/重试库。

## 自定义数字人素材

- 目标：上传用户自己的生成图片或待机视频，并在 OBS 舞台持续展示。
- 调研结论：不新增第三方包。
- 采用：
  - Next.js Route Handler 原生 `Request.formData()` 接收文件；
  - Node.js `fs/promises` 保存素材和元数据；
  - HTML 原生 `<img>` / `<video autoplay loop muted playsInline>` 播放；
  - Node.js 文件流提供标准 HTTP Range 响应，覆盖显式、开放结尾和后缀字节范围，支持 OBS Chromium 浏览器源按需缓冲和循环跳转。
- 原因：当前只需处理单个本地素材，现有平台能力已完整覆盖；引入上传 SDK、对象存储 SDK或视频播放器会增加体积和配置，却不提供必要价值。
- 输入限制：JPEG、PNG、WebP、MP4、WebM，最大 50MB；文件只保存在本机 `data/avatar`。
- 后续升级条件：多人部署或跨机器运行时，再评估 MinIO/S3 兼容对象存储；需要实时写实口型时，再接入 MuseTalk/AvatarAI。

## 会议音频采集与中文转写

- 目标：不依赖候选人选择的会议软件，采集本机播放的候选人语音并转换为回答文本。
- 采集方案：浏览器标准 `getDisplayMedia({ audio: true })` 和 `MediaRecorder`。
- 采集依赖：无第三方包。用户每次面试主动选择会议窗口或整个屏幕并勾选“共享音频”；浏览器按独立 WebM/Opus 片段上传。
- 转写首选：[whisper.cpp](https://github.com/ggml-org/whisper.cpp) 的 `whisper-server`。
- 许可证：MIT。
- 首选原因：可在本机 CPU/GPU 运行，数据不离开电脑，没有按分钟费用，并提供 multipart HTTP `/inference` 接口。
- 兼容兜底：OpenAI-compatible `/audio/transcriptions`，复用现有模型服务配置；适合不想下载本地模型或电脑性能不足的场景。
- 暂不采用：
  - `faster-whisper`：MIT 且性能良好，但需要额外 Python/CTranslate2 运行环境；本项目当前为纯 Node.js，接入和分发成本高于 whisper.cpp 单文件服务。
  - 浏览器 SpeechRecognition：不能可靠地直接接收任意会议软件的系统音频流，且实现和数据处理因浏览器而异。
- 已知限制：`getDisplayMedia` 的系统音频支持取决于浏览器和所选共享对象；第一版要求使用最新版 Edge/Chrome，并始终保留人工输入兜底。
- 传输与凭据边界：复用模型端现有的 URL 安全判断，不增加 URL 校验依赖。OpenAI-compatible 转写和 whisper.cpp 端点的远程地址必须为 HTTPS，只有 `localhost`、`127.0.0.1`、`::1` 允许 HTTP。独立的 `TRANSCRIPTION_API_KEY` 始终优先；未提供时，仅当规范化后的转写 Base URL 与模型 Base URL 完全相同才复用模型密钥，避免把一个供应商的凭据发送给另一个转写服务。
- 自动化：`scripts/setup-whisper.ps1` 从 whisper.cpp 最新官方 Release 选择 CPU x64 包，下载并校验官方多语言模型；缺少 FFmpeg 时通过 winget 安装。`scripts/start-whisper.ps1` 负责启动、PID 复用和就绪检查。

## OBS 自动配置与虚拟摄像头控制

- 目标：减少人工配置 OBS 的步骤，从控制台创建专用场景、浏览器源并启停虚拟摄像头。
- 采用：[obs-websocket-js](https://github.com/obs-websocket-community-projects/obs-websocket-js)。
- 许可证：MIT。
- 原因：OBS 28+ 已内置 obs-websocket v5；该客户端由 OBS WebSocket 社区维护，通过 npm 发布，并提供与协议请求对应的 TypeScript 类型。
- 接入边界：源码浏览器流程仍可手工连接用户的 OBS；打包客户端由 Electron 主进程连接专用 `ws://127.0.0.1:4455`，渲染页面只调用受限 IPC，不接收密码或连接地址。持久密码策略见下方“OBS WebSocket 零配置启动”。
- 自动操作：读取 OBS 版本、创建或更新 `AI Interviewer` 场景、创建或更新 `/stage` 浏览器源、切换 Program Scene、启动/停止 Virtual Camera。
- 不自行实现：虚拟摄像头驱动和 OBS 场景文件格式。
- 音频限制：OBS Virtual Camera 只提供视频设备，不能作为麦克风；会议软件的音频输入仍需独立的虚拟音频设备或系统已有的 Loopback/Stereo Mix。
- 最终设备自检：复用浏览器标准 `MediaDevices.enumerateDevices()` 与 `getUserMedia()`，在用户点击后取得视频权限、按 `deviceId` 精确打开 `OBS Virtual Camera` 并本地预览。规范要求未授权前标签和 ID 可能隐藏，因此只在显式操作时短暂打开默认视频流以解锁标签并立即停止；预览可主动停止且组件卸载自动释放，不上传或保存画面，不新增 WebRTC 库。

## Windows 虚拟麦克风线路

- 目标：把 `/stage` 的浏览器 TTS 作为系统麦克风输入提供给任意会议软件。
- 开源首选：[Virtual-Audio-Driver](https://github.com/VirtualDrivers/Virtual-Audio-Driver)，MIT；提供 Windows 10/11 虚拟扬声器和虚拟麦克风设备。
- 风险：项目仍标注为 beta；非正式签名构建可能要求 Windows 测试签名模式。只链接官方 Release，不由本项目静默安装驱动或修改系统启动设置。
- 成熟兜底：[VB-CABLE](https://vb-audio.com/Cable/)，Donationware Simple，并非开源；OBS 官方视频会议教程采用该线路。企业使用前应核对其授权要求。
- 已复用能力：
  - OBS 浏览器源的 `reroute_audio` 把网页语音放入 OBS 混音器；
  - obs-websocket `SetInputAudioMonitorType` 自动把舞台源设为“仅监听”；
  - 浏览器 `navigator.mediaDevices.enumerateDevices()` 在用户授权后检测虚拟麦克风是否出现。
- 必须保留的人工步骤：安装系统驱动、在 OBS 选择全局监听设备、在会议软件选择麦克风。浏览器和 OBS WebSocket 均不能安全地替用户修改所有第三方会议软件的设备设置。
- 设备自检：复用浏览器标准 `getUserMedia` 与 `enumerateDevices`，同时识别虚拟录音端和播放端，兼容 VB-CABLE、Virtual Audio Driver 和 Voicemeeter 的明确成对设备；只有两端同时存在并通过真实音量采样才显示线路完整。BlackHole 是 macOS 方案，ToDesk 等远控音频端点不能证明通用会议回传能力，均不用于 Windows 门禁放行。
- Windows 安装修复：继续使用固定版本且已验证签名的 Virtual-Audio-Driver，不新增安装依赖。INF 路径通过 UTF-8 JSON 临时请求传给提权 PowerShell，再以参数数组调用系统 `pnputil.exe`，避免含空格、中文或 PowerShell 元字符的路径被拆分；安装结果通过临时 JSON 返回，客户端区分 UAC 取消、资源缺失、签名拒绝、系统安装失败及等待重启。现有官方/开源方案已经提供驱动与系统安装工具，自行开发驱动或引入另一套安装框架会增加签名、安全和维护成本，因此不采用。

## 单人会话持久化与导出

- 目标：服务重启后保留当前面试记录，并允许招聘人员下载留档。
- 采用：Node.js 内置 `fs/promises`、项目现有 Zod 和 JSON；不新增数据库或 ORM。
- 人类可读导出：保留 JSON 原始数据下载，同时由纯 TypeScript 确定性生成 Markdown 对话与证据纪要；候选人、JD 和模型文本均转义 Markdown 控制字符，防止内容伪装成报告标题或结构。当前会话和历史归档共用渲染器，不引入文档生成依赖。
- 原因：第一阶段明确是单机、单人面试，同时只有一个活动会话。SQLite/Prisma 会引入原生二进制、迁移和额外分发成本，当前没有并发查询价值。
- 数据安全：写入 `data/interviews/current.json` 前先写同目录临时文件，再用原子 rename 替换，降低进程中断造成半文件的风险；写操作在进程内串行化。
- 活动会话保护：`start` 在服务端检测到 `running` 时返回 409，控制台同步禁用开始按钮；必须先结束并归档当前面试，才能创建下一场，避免未结束记录被静默覆盖。
- 整轮原子提交：回答请求携带控制台看到的 `expectedRevision`。服务端先用仅存在内存的临时历史生成追问，成功后在现有串行 `mutateSession` 中再次校验版本，一次写入“候选人回答 + 下一问”；最后一题则一次写入“回答 + 结束语 + finished”。并发旧请求返回 409，模型失败不再留下只有回答、没有追问的半轮记录。现有 Zod、乐观版本和原子队列已覆盖单进程需求，不引入状态机或数据库锁依赖。
- 输入恢复：人工提交发生模型错误或版本冲突时，原文字段放回回答输入框；自动转写提交失败时也转入该输入框等待复核，避免并发保护以丢失候选人内容为代价。
- 迁移能力：Zod 在读取时兼容并补齐新增字段。进入多人或多进程部署阶段时，应改用 SQLite/PostgreSQL，届时复用当前 `InterviewSession` 数据边界。

## 结构化面试配置与题数控制

- 目标：让问题围绕真实 JD 和面试重点，并在设定题数后自动收尾。
- 调研结论：表单状态、输入校验和服务端计数均已被 React、Zod 与现有会话模型覆盖，不引入表单库或工作流引擎。
- 采用：把岗位要求、面试重点和 2–20 的问题上限存入 `InterviewSession`；生成追问时作为模型系统上下文，提交最后一题回答后直接进入结束语。
- 原因：单人串行面试尚不需要 XState/Temporal 等状态机或编排依赖；明确的会话状态和串行持久化已经覆盖当前边界。
- 现场接管：追问不合适时可“重生成本题”，服务端用移除当前题后的历史重新请求模型，再原子替换最后一条面试官问题；不会重复候选人回答或增加题数。候选人回答、人工播报、结束面试和问题替换都要求会话处于运行中，避免结束后误改归档。复用现有会话队列和模型接口，不增加工作流依赖。
- 发言类型：转录条目标注 `opening`、`question`、`manual`、`answer` 或 `closing`。问题上限和历史题数只统计开场题与正式追问，人工接管说明和结束语不占题数；旧记录缺少类型时继续按原面试官问题兼容读取。
- 重生成并发保护：控制台提交当前 `expectedRevision`，服务端在调用模型前和原子替换时同时校验版本及原问题时间戳；生成期间若回答、人工接管或结束操作改变轮次，旧结果返回 409，不能覆盖新问题。
- 转写纠错：最近一轮必须是“候选人回答 + AI 追问”时，面试官可修正回答。服务端先用修正后的临时历史生成新追问，模型成功后再用原始时间戳作并发校验，一次原子操作替换回答和问题；模型失败或会话已变化均不写入部分结果。

## 语音活动检测与自动追问

- 目标：候选人说完后自动完成切片、转写和追问，减少面试官现场点击。
- 采用：[`@ricky0123/vad-web`](https://github.com/ricky0123/vad) 0.0.30，ISC；内部使用 Silero VAD 与 ONNX Runtime Web。
- 原因：支持通过 `getStream` 注入已有的会议系统音频 `MediaStream`，能直接回调完整 16kHz 语音段，并自带 WAV 编码工具；无需自研能量阈值、重采样和 AudioWorklet。
- 资源策略：VAD v5 模型、Worklet 与实际使用的 ONNX WASM 后端在 `predev`/`prebuild` 阶段从 npm 依赖复制到 `public/vendor/vad`，运行时不请求第三方 CDN；不复制 WebGPU/JSPI 等当前未启用后端。
- 行为：连续约 2.5 秒静音且有效语音不少于约 0.9 秒后，自动上传该语音段并生成下一问；操作员可关闭自动追问，恢复固定 10 秒切片和人工校对。
- 风险控制：自动模式只在活动面试中提交；停止听取会销毁 VAD、停止共享流。会议回声或长停顿仍可能误切，因此人工模式始终保留。
- 半双工防回声：生成开场、追问、结束语或人工播报后，如果舞台在线，立即调用现有 `MicVAD.pause()`；舞台状态确认语音播放结束后再调用 `start()` 恢复监听。等待舞台回报设置 30 秒自动释放，停止采集时同步清理，避免 AI 自己的声音被识别成候选人回答。复用 `@ricky0123/vad-web` 已有接口和舞台状态，不增加回声消除依赖。
- 跨轮保护：每个 VAD 语音段记录捕获时的会话 `revision`；转写完成时只有版本未变化且记录末尾仍是面试官问题才允许自动提交。排队期间若已生成新题或上一模型请求失败，文本转入人工输入框并提示复核，避免旧语音被错误归到下一题，也不丢失候选人内容。

## Windows 安装、预检与统一启动

- 目标：把 npm 依赖、OBS、Whisper、本地服务和浏览器启动收敛成少量命令。
- 调研与采用：
  - OBS 使用 Windows 自带/官方分发的 `winget` 客户端及当前清单 ID `OBSProject.OBSStudio`；
  - Whisper 复用项目已有的 `setup-whisper.ps1` 和 `start-whisper.ps1`；
  - 端口、进程、音频端点和可执行文件检测复用 PowerShell 内置命令；
  - Next.js 仍使用 npm scripts，不引入 PM2、Docker Desktop 或额外安装器框架。
- 后台进程：使用 Node.js 内置 `child_process.spawn({ detached: true })` 和日志文件启动现有 Next CLI；日常面试强制使用 production `next start`，避免舞台出现 Next Dev Tools 标记。首次安装完成生产构建，缺少 `BUILD_ID` 时启动脚本自动补建；不引入 PM2/concurrently。
- 启动就绪身份：继续复用现有 Next.js `/api/health` 和 PowerShell `Invoke-WebRequest`，不增加健康检查或进程管理依赖。响应包含稳定的 `authorized-interview-screen-helper` 服务标识；启动器同时校验 HTTP 200、服务标识和 `status=ok` 后才认为应用已就绪，避免端口上其他 HTTP 服务碰巧提供 `/api/health` 时被误判并打开错误页面。
- 进程停止所有权：停止脚本优先读取启动器写入的项目 PID，再以默认端口作为旧版本兼容回退；进程名称和命令行中的工作区路径仍必须同时匹配。这样自定义端口实例可以正常停止，默认端口被其他 Node 项目占用时也不会优先触碰无关进程。
- 原因：当前目标是单台 Windows 电脑和有限预算。PM2/Docker/自定义 MSI 会引入常驻服务、虚拟化或签名维护成本，现阶段没有收益。
- 安全边界：统一安装脚本只在用户主动运行后安装 OBS/Whisper；不会自动下载或安装虚拟音频驱动，也不会开启 Windows 测试签名模式。统一启动只启动本项目、已安装 OBS 和已配置的 whisper-server。
- 双击入口：复用 `.cmd`、现有 PowerShell 和 npm 脚本，不引入 Electron、Tauri、MSI/WiX 或自动更新框架。`Start-AI-Virtual-Assistant.cmd` 日常启动，`Check-AI-Virtual-Assistant.cmd` 只读检查；`First-Time-Setup.cmd` 必须先选择最小安装（依赖+OBS，跳过 Whisper）、完整安装或退出，选择前不会执行安装下载。
- 低预算本机档位：首次安装菜单增加显式的 `Local` 选项，按顺序复用完整 Windows 安装与现有 `setup-ollama.ps1`，安装 whisper.cpp、Ollama 和 `qwen3.5:4b`。Ollama 官方 Windows 文档说明原生应用在本机提供 `http://localhost:11434`；Ollama registry 当前标注 4B 模型约 3.4GB。该选项在选择前展示下载量，不把模型下载隐藏在“最小安装”里；任一步失败立即停止，不继续写入模型配置。
- Node 首次引导：Node 官方当前将 v24 标记为 LTS，v22 仍为 LTS，而 v20 已 EOL，并建议生产应用使用 Active/Maintenance LTS。双击安装不能预设新电脑已有 npm，因此复用 Windows Package Manager 社区仓库的精确包 `OpenJS.NodeJS.LTS`：无 Node 时安装、低于 22 时升级、满足要求时不动作。`ensure-node.ps1 -DryRun -Json` 可只读审计计划；安装后主脚本直接从标准安装目录重新定位 `npm.cmd`，无需依赖旧 PowerShell 进程自动刷新 PATH。不使用远程脚本管道或自行分发 Node 二进制。
- 预检复用：中文声音调用统一的 `sapi-voices.ps1`，因此继承 System.Speech→SAPI COM 兜底；模型配置同时识别 `.env.local` 和 DPAPI 设置文件中的密文字段，只报告是否配置，不解密或输出密钥。

## 历史归档与证据型面试纪要

- 目标：开始下一场面试后仍能保留过往记录，并为招聘人员生成可审阅纪要。
- 依赖复用：继续使用 Node.js `fs/promises`、现有 Zod、现有 OpenAI-compatible Chat Completions 适配；不新增数据库、AI SDK 或报表依赖。
- 归档方式：结束状态和后续纪要更新都会原子写入 `data/interviews/archive/{sessionId}.json`；历史 API 只读取通过 Zod 校验且文件名安全的记录。
- 纪要边界：
  - 只整理原始回答、明确表现、待追核事项与信息限制；
  - 不生成录用/淘汰建议、候选人排名、总分或敏感属性推断；
  - 模型返回的每条引文必须能在候选人原话中逐字匹配，否则自动移除并记录限制；
  - 纪要始终标记 `humanReviewRequired: true`，最终判断由招聘人员结合岗位标准和原始记录完成。
- 模型兼容：优先请求兼容的 JSON Object 输出；若上游明确返回 400，则自动重试普通 Chat Completions，并继续使用 Zod 严格校验返回结构。
- 不采用现成 ATS/评分框架：当前是单机单人版本，接入完整 ATS 会引入账户、云端候选人数据和订阅成本；自动评分还会扩大高影响招聘决策风险。

## 本机访问、AI 告知与数据删除

- 目标：降低候选人记录意外暴露、未告知使用 AI 和本地数据无限保留的风险。
- 依赖复用：Next CLI 的 hostname 参数、现有 Zod、Node `unlink` 和浏览器原生 `confirm()` 已覆盖需求，不引入登录系统或删除确认组件。
- 本机边界：`npm run dev`、`npm start` 和 Windows 一键启动均显式绑定 `127.0.0.1`，不默认向局域网开放控制台、候选人记录或模型接口。
- 告知确认：开始请求必须包含字面值 `consentConfirmed: true`；控制台要求面试官确认已说明 AI 协助、记录保存和人工复核，确认时间随会话保存。开场白也会明确说明 AI 面试官和人工复核。
- 删除：历史列表提供永久删除，前端先显示不可恢复确认；服务端验证 sessionId 后删除精确归档文件。若删除的正是当前已结束会话，同时清空 current，避免残留另一份候选人数据。
- 限制：此确认是面试官的操作记录，不替代企业根据所在地法律制定的隐私告知、保留期限、访问控制和候选人权利流程。

## 本机模型配置与密钥保护

- 目标：非开发用户无需手改 `.env.local` 和重启即可配置 OpenAI-compatible 模型，同时避免明文 JSON 存储密钥。
- 采用：Windows 内置 DPAPI（CurrentUser）、Node `child_process.spawnSync`、现有 Zod 和原子 JSON 写入；不引入云端密钥库或第三方凭据 SDK。
- 存储：`data/settings/model.json` 只保存模型地址、模型名和 DPAPI 密文；明文通过 PowerShell 标准输入传递，不出现在命令行参数、日志、GET 响应或前端状态回填中。
- 运行时：首次读取后仅在本机 Node 进程内存缓存解密结果；保存后立即生效，不要求重启。原有 `OPENAI_*` 环境变量继续兼容，若存在加密设置则由设置优先。
- 传输限制：远程模型地址必须使用 HTTPS；仅 `localhost`、`127.0.0.1` 和 `::1` 允许 HTTP，降低误把密钥发送到明文远程连接的风险。
- 浏览器响应头：复用 Next.js 官方 `headers()` 配置，不引入 Helmet 等重复中间件。控制台和舞台保持静态生成，因此采用官方无 nonce CSP 路径；`script-src` 保留 Next 静态注水所需的 `unsafe-inline`、Silero/ONNX WebAssembly 所需的 `wasm-unsafe-eval`，开发模式才增加 `unsafe-eval`。`connect-src` 仅允许同源与本机 OBS WebSocket；`media-src`/`worker-src` 只增加本机 Blob。另设置 `frame-ancestors 'none'`、`X-Frame-Options: DENY`、`nosniff`、无 Referrer 和最小 Permissions Policy，并关闭 `X-Powered-By`。OBS Browser Source 顶层加载 `/stage`，不依赖 iframe。
- 删除：用户可从控制台删除加密密钥；空密钥状态会覆盖环境变量回退，避免 UI 显示删除后仍继续使用旧密钥。
- 限制：DPAPI 密文绑定当前 Windows 用户和机器，不能直接复制到另一台电脑；非 Windows 环境继续使用环境变量配置。

## OBS WebSocket 零配置启动

- 目标：日常运行时不再要求用户打开 OBS 菜单复制 WebSocket 密码。
- 调研：OBS 28+ 已内置 obs-websocket 5。官方提供端口和密码命令行覆盖参数，但没有启用服务器的覆盖参数；而且把密码放入参数会被 OBS 记录到启动日志。obs-websocket 的持久配置包含 `server_enabled`、`server_port`、`auth_required` 与 `server_password`，密码上游设计为明文以便服务启动时读取。
- 采用：打包客户端继续复用官方 OBS 32.2.1、现有 `obs-websocket-js 5.0.8` 和 Electron `safeStorage`，不新增依赖。启动前原子写入专用便携目录的 obs-websocket 配置，强制启用服务器、4455 端口、鉴权并关闭提示；命令行仅保留官方 `--websocket_ipv4_only` 等无秘密参数。
- 密钥：首次运行生成 256 位随机长期密码。加密主副本保存在用户数据目录 `secrets/managed-obs-password.bin`，Windows 下由 `safeStorage` 的 CurrentUser DPAPI 保护；同一密码按 OBS 上游要求同步到专用运行目录的明文配置。它不进入命令行、渲染页面、IPC、应用日志或 OBS 启动日志。
- 安全边界：客户端只连接 `127.0.0.1:4455`，强制鉴权且不创建防火墙例外；OBS 32.2.1 上游只有 IPv4/双栈选择，尚无仅绑定回环地址的正式配置，因此 WebSocket 可能同时监听本机 IPv4 网卡。专用配置与 `%APPDATA%\\obs-studio` 隔离，只归当前 Windows 用户；同一用户下的恶意本机进程仍属于信任边界，不能把 DPAPI 或文件权限描述为同用户进程隔离。
- 生命周期：连接、场景、Virtual Camera 和人工麦克风路由都留在 Electron 主进程。渲染层只收到版本、摄像头状态和稳定错误码；冷启动最多等待 30 秒。只终止可执行路径精确匹配专用运行目录的遗留进程，用户自己的 OBS 仅提示关闭。

## 面试前输出门禁

- 目标：避免模型已配置但候选人实际看不到画面或听不到声音时误开始面试。
- 调研与复用：OBS 官方 Virtual Camera 已把场景暴露为标准摄像头；浏览器标准 `MediaDevices.enumerateDevices()` 与 `getUserMedia({deviceId:{exact}})` 可以在授权后枚举并读取指定设备。继续复用现有 `obs-websocket-js`、OBS 状态和浏览器设备 API，不引入 Electron、原生摄像头模块或自定义驱动。
- 门禁：开始新面试前必须同时确认模型、舞台、素材、中文语音、OBS 连接、虚拟摄像头运行、最终摄像头预览和虚拟麦克风线路。最终预览通过后允许释放设备，验证状态保留；OBS 停止虚拟摄像头时验证状态立即失效。
- 设备变化：复用标准 `MediaDevices.devicechange` 监听摄像头、麦克风或扬声器的连接变化，发生变化立即撤销旧验证。由于该事件并非所有浏览器都完整支持，摄像头和虚拟音频验证还会在 5 分钟后自动过期，要求面试前重检；不增加设备轮询库。
- 语音实测：不能只凭系统枚举到中文声音即放行。控制台通过独立同源测试消息让舞台实际合成并完整播放，收到舞台的 `lastSpeechAt` 成功回报后才通过；测试消息不创建会话、不修改转录记录。该短消息复用现有轮询和进程内状态，不为单机应用增加消息队列或第二套 WebSocket。
- 自动播放恢复：舞台保存最近一次待播文本，包含正式提问与独立测试语音。若 SAPI 不可用且 Chromium 拒绝无用户手势的 Web Speech，舞台都会显示“启用声音并重播”，用户在 OBS 浏览器源“交互”中点击后可恢复；测试语音不再因不属于面试会话而丢失恢复入口。
- 错误呈现：控制台不直接展示 `sapi-http-*`、`web-speech:*` 等内部错误串，而是用本地映射给出自动播放解锁、SAPI 环境检查、中文语音包安装、设备独占或服务重试建议。复用现有错误分类，不引入监控或国际化依赖。
- 成本与安全：零新增依赖、零云端费用；摄像头和音频设备标签仅在用户授权后读取，预览流只留在浏览器内存，不上传或保存。
- 限制：网页无法确认候选人选择的任意第三方会议软件内部具体设备，因此仍需在会议软件入会预览中确认一次；门禁证明本机标准设备线路可读，不替代第三方软件自身检查。
- 会议软件最后一跳：Teams 等会议软件的官方文档把摄像头预览、麦克风和摄像头选择放在客户端入会页或设备设置中；浏览器没有跨进程读取这些选择的标准 API。项目不引入桌面自动化或针对单一会议软件的私有接口，而是在本机摄像头与音频实测通过后，要求面试官填写本场软件并确认入会预览画面和麦克风音量。任何上游 OBS、摄像头或音频验证失效都会撤销该确认，避免把“设备存在”误报为“对端已收到”。
- 虚拟音频配对：只认可有明确播放端→录音端语义的成对设备，目前包括 VB-CABLE、Virtual-Audio-Driver 和 Voicemeeter。ToDesk、Sunshine、Parsec、Remote Desktop 等远控音频端点不会用于放行，因为其官方用途是远控声音传输，不能证明可作为任意会议软件的通用回传线；控制台会提示检测到但不误判为就绪。
- 音频实测：设备名称配对后，使用 `getUserMedia({deviceId:{exact}})` 打开对应虚拟麦克风，复用 Web Audio `AnalyserNode.getByteTimeDomainData()` 计算基线与测试期间 RMS。控制台让舞台播放独立测试语音，只有虚拟麦克风能量显著高于基线才通过，从而覆盖 OBS 监听设备、舞台源监听模式和驱动转发的完整链路；采样流测试后立即关闭，不上传或保存。

## 本机写接口同源保护

- 风险：即使服务只监听回环地址，外部网页仍可通过普通 HTML 表单向本机端口发送跨站 `multipart/form-data`；头像上传会改变舞台内容，音频上传还可能触发远程转写费用。
- 调研与采用：复用 Next.js 15 官方 Middleware，在 `/api/:path*` 路由前统一检查浏览器不可自行伪造的 `Origin` 与 `Sec-Fetch-Site`。OWASP 建议同时使用 Fetch Metadata 与严格 Origin 比对；不引入 CSRF 框架或会话依赖。
- 策略：GET/HEAD 等只读请求不拦截；POST/PUT/PATCH/DELETE 遇到 `cross-site`、`same-site`、`Origin: null` 或与目标完整 origin 不一致时返回 403。无浏览器头的本机 Node/PowerShell 自动化继续允许，以保留安装检查和测试能力。
- 边界：这是浏览器 CSRF 防护，不把回环 API 变成面向不可信本机进程的认证服务；同一 Windows 用户下的恶意进程仍可能直接调用本机端口。

## 公平招聘追问约束

- 原则来源：ILO 公平招聘原则要求消除就业和职业歧视；NIST AI RMF 要求在系统生命周期中持续管理有害偏差；EEOC 明确建议招聘时避免询问种族、宗教、性别、国籍、年龄、怀孕和生育计划等受保护或个人特征。企业仍需根据实际用工地法律和岗位要求制定正式规则。
- 采用：在追问系统提示词中限定只问岗位能力和明确工作经历，禁止年龄、性别、民族、户籍籍贯、宗教政治、婚育家庭、健康病史、残障和性取向等个人敏感问题。
- 本地兜底：模型输出后用小型中文模式表识别直接针对候选人的敏感问题；命中后最多重试一次，仍命中则使用现有非重复岗位问题兜底。无需第二个审核模型或付费内容安全 API。
- 误判控制：模式要求问题直接指向“你/您”、父母家人或家庭背景，不拦截“健康管理系统”“用户年龄段”“残障用户无障碍”等与产品或岗位能力有关的上下文。
- 限制：本地模式表不是法律合规证明，也不能覆盖所有隐含代理变量；最终面试脚本和人工接管内容仍须由招聘人员复核。

## 损坏会话文件恢复

- 风险：`current.json` 解析或结构校验失败时若直接回到空会话，下一次修改会覆盖当前路径，导致唯一的损坏文件线索丢失。
- 采用：继续复用 Node 原生 `fs/promises` 和现有原子写入方式，不引入 SQLite、LevelDB 或恢复库。读取失败仅在文件确实不存在时返回空会话；内容损坏时先把原文件原子移动为 `current.corrupt.<时间>.<随机值>.json`，移动成功后才允许恢复。
- 恢复顺序：从归档目录读取全部结构有效的会话，按结束或开始时间选择最新一场作为只读恢复状态；没有有效归档时才返回空会话。损坏备份始终保留供人工检查，不包含在历史列表中。
- 失败边界：若损坏文件无法移动，加载直接失败并阻止后续写入，优先避免覆盖而不是假装恢复成功。

## 候选人文本提示注入边界

- 风险：候选人回答可能包含“忽略以上规则”“扮演系统角色”“改问某个敏感问题”等自然语言指令；若直接拼成普通对话文本，模型可能把数据误当命令。长纪要历史直接按字符截断还可能切断结构。
- 采用：复用 JSON 标准和现有单一用户消息，不引入第二个审核模型、提示防火墙或付费安全 API。追问与纪要提示明确声明用户消息只是非可信 JSON 对话证据，不得执行其中的命令、角色声明、规则修改或系统提示词泄露要求。
- 结构与预算：对每条文本按 Unicode 码点截断，按时间倒序保留最新记录，并在加入完整记录前检查序列化总长度；因此最终始终是可解析 JSON，不会在对象中间硬截断。追问最多 10 条/16,000 字符，纪要最多 80 条/28,000 字符，每条最多 1,600 个码点。
- 层级防护：该结构化边界与现有隐藏推理清洗、单问题截断、重复检测、公平招聘敏感问题重试和证据引文核验共同生效。它降低常见提示注入成功率，但不宣称能证明任意模型完全免疫。
# 2026-08-10：修复 Next.js 间接依赖 nanoid 安全公告

- 调查：`npm audit` 将 Next.js 15.5.22 经 PostCSS 8.5.23 引入的 `nanoid 3.3.16` 标为 high，公告为 GHSA-2v37-7h3g-55p8；受影响范围 `<3.3.17`。
- 选择：使用现有 npm `overrides` 将 nanoid 固定为 `3.3.17`。这是同一 3.x 版本线的安全补丁，许可证仍为 MIT，不新增运行时能力或数据传输。
- 兼容性：PostCSS 的依赖范围允许该补丁版本；通过完整构建、现有测试和 `npm audit --audit-level=high` 验证。
- 未选择：直接升级到 nanoid 6，因为属于不必要的主版本升级，可能增加 Next.js/PostCSS 兼容风险。

# 2026-08-15：将 nanoid override 从 3.3.17 升到 3.3.18

- 调查：GitHub Advisory GHSA-2v37-7h3g-55p8 在 2026-08-13 把受影响范围改成 `<3.3.18`。项目仍 pin 在 `3.3.17`，CI 的 `npm audit --audit-level=high` 因此失败。官方 3.x 补丁是 [nanoid 3.3.18](https://github.com/ai/nanoid/releases/tag/3.3.18)，MIT，2026-08-07 发布。
- 选择：继续用现有 npm `overrides`，只把 nanoid 从 `3.3.17` 改到 `3.3.18`。不新增依赖、不改业务代码、不升级 PostCSS 或 Next.js。
- 兼容性：仍在 PostCSS 8.5.23 声明的 `nanoid@^3.3.16` 范围内；业务代码不直接调用 nanoid，该包只用于 CSS/source map 内部 ID。
- 未选择：去掉 audit 门禁，或跨主版本升到 nanoid 5/6。前者会让高危漏洞漏过；后者对 PostCSS 的 CJS `require('nanoid/non-secure')` 不兼容。

# 2026-08-10：Windows 桌面壳与安装打包

- Electron：固定 `43.3.0`，MIT。官方文档推荐配合独立打包工具；它保留现有 Next.js 服务端 API，避免将项目重写为纯静态前端。代价是安装体积与内存高于 Tauri，但当前复用成本最低。
- electron-builder：固定 `26.15.3`，MIT，使用 NSIS 生成 Windows x64 安装器。它支持 extraResources、安装钩子和 Windows 签名，适合打包 OBS/驱动前置组件。
- 未选择 Electron Forge 7.11.2：虽然是 Electron 官方推荐工具，但本次安装后 `npm audit` 报告 19 个 high 和 1 个 critical，来自构建链中的 `tar`、`tmp` 等依赖；默认无安全修复路径。切换 electron-builder 后审计为 0 漏洞，因此不接受通过跨主版本 overrides 强行覆盖。
- 安全：Electron 渲染进程关闭 Node integration，开启 context isolation 和 sandbox；安装资源固定 SHA-256 并验证 Authenticode。构建工具只作为 devDependency，不进入网页运行时数据链路。
- 维护：electron-builder 当前稳定版本仍有发布与 Windows NSIS 支持；构建链存在部分 deprecated 间接包警告，但 `npm audit --audit-level=high` 为 0，后续每次发布重新核验。

# 2026-08-10：音频捕获与火山 RTC 字幕

- 会议音频捕获：采用微软官方 `ActivateAudioInterfaceAsync` Application Loopback 接口模式，按选定会议进程树捕获。官方示例表明可包含指定进程及子进程；目标系统版本不支持时仅在用户确认后降级到 WASAPI 整体输出捕获。
- 捕获实现依赖：采用 NAudio.Wasapi `3.0.0-preview.20`（MIT）的 `WasapiRecorderBuilder.WithProcessLoopback`，使用本机已有 .NET SDK 构建自包含 x64 sidecar。该 API 要求 Windows 10 2004/build 19041 或更高。当前为 preview，必须固定版本并通过两种会议软件实机测试；若后续稳定版可用，发布前优先升级稳定版。未选择自行移植微软 C++ 示例，因为本机无 MSVC 且 COM 生命周期、格式转换和泄漏风险更高。
- RTC：优先火山引擎官方 Electron/Windows SDK、自定义音频源和 `startSubtitle` 字幕回调。SDK 版本、许可、计费、数据地域和二进制重分发权仍是接入闸门；没有官方许可文本时不把 SDK 二进制提交到 GitHub 或安装包。
- 最小验证：官方 npm 包 `@volcengine/rtc 4.69.0`，BSD-3-Clause，仅新增 `eventemitter3` 运行依赖，`npm audit` 为 0。其官方类型定义确认具有 `setExternalAudioTrack`、`setAudioSourceType`、`startSubtitle` 和 `onSubtitleMessageReceived`，可在 Electron 的 Chromium 渲染环境接收由 Web Audio 生成的外部 `MediaStreamTrack`；因此不采用额外的火山 Windows DLL sidecar。
- 监听：复用会议软件原始播放，不重新播放回环 PCM，避免双声和回声。
- 人工介入：本机真实麦克风与 AI TTS 通过互斥混音写入虚拟麦克风；人工通道不发送到 RTC 字幕房间。
- 数据：原始 PCM 默认不落盘，增量字幕只显示，最终字幕才持久化；RTC Token 使用 DPAPI，AppKey 不进入客户端。

# 2026-08-10：人工介入音频混音

- 调研：OBS 32 已内置 obs-websocket；官方协议提供 `CreateInput`、`SetInputAudioMonitorType` 与 `SetInputMute`，OBS 官方源 API 明确“仅监听”会把音频发送到监听设备。现有 `obs-websocket-js` 5.0.8 已覆盖这些请求，无需新增依赖。
- 采用：一键配置创建 `wasapi_input_capture` 默认麦克风源，AI 舞台和人工麦克风都设为“仅监听”。按住说话时静音 AI、打开人工麦克风；松开后两者都保持静音；只有点击“恢复 AI”才重新打开 AI。紧急静音关闭两路。
- 输出：OBS 监听设备仍由用户在“设置 → 音频 → 高级 → 监听设备”选择已安装的虚拟音频播放端；会议软件选择对应录音端。obs-websocket 没有受支持的全局监听设备设置请求，因此不修改 OBS 私有配置文件。
- 许可证与成本：复用 OBS（GPL-2.0）和 obs-websocket-js（MIT），零新增体积、云端费用和密钥流转。应用通过标准 WebSocket 进程集成 OBS，不复制其源码。
- 限制：默认使用 Windows 当前默认麦克风；发布前必须在真实 OBS、虚拟音频驱动和至少两种会议软件上人工验证，自动化测试只验证调用序列。

# 2026-08-10：火山 RTC 临时 Token 绑定

- 官方约束：火山 RTC 文档要求测试 Token 使用的 AppID、RoomID、UserID 与客户端进房参数完全一致；正式上线则应由业务服务端使用密钥 SDK 动态生成并下发 Token。AppKey 只留在服务端。
- 采用：试用配置显式保存临时 Token 对应的 RoomID/UserID，并在进房时复用；Token 使用 Windows DPAPI 加密。正式模式仍随机生成单场 RoomID/UserID，再向用户配置的 HTTPS Token 服务请求短期 Token。
- 字幕前置：RTC 控制台必须开启实时字幕和流式语音识别，并配置语音技术控制台创建的流式语音识别 APP ID、Access Token、Cluster ID；这与 RTC AppID/AppKey 是两套凭据，均不写入客户端源码。

# 2026-08-11：Windows 安装与 standalone 启动修复

- 调查结论：继续使用 Next.js 15 官方 `output: "standalone"` 产物。官方产物的根 `server.js` 与同级追踪依赖已经构成最小运行目录，只需补复制 `public` 和 `.next/static`；递归搜索同名入口会误命中 `.next` 内部路由文件并漏掉 `node_modules`。electron-builder 默认忽略规则还会过滤父目录 extraResources 内的嵌套 `node_modules`，因此将 standalone 的追踪依赖作为独立白名单资源复制，并用打包后可执行文件健康检查约束最终产物。
- 安装选择：继续使用现有 electron-builder 26.15.3（MIT）与其 NSIS 能力，不引入第二套安装框架。安装改为显式 per-user one-click，并通过 electron-builder 官方 NSIS include 扩展把 `APP_FILENAME` 固定为产品名；NSIS 自动创建 `%LOCALAPPDATA%\\Programs\\AI Virtual Assistant`，不要求用户选择或预建目录，也不为客户端本体申请管理员权限。
- 故障诊断：复用 Electron `app.setName`、`dialog` 和 Node 子进程/文件 API，固定用户数据目录产品名，并把本地服务启动输出脱敏后写入 `%APPDATA%\\AI Virtual Assistant\\logs\\desktop-startup.log`；失败时显示路径，不增加遥测、不上传日志，API Key、Token、密码和 URL 凭据会在落盘前过滤。
- 兼容与成本：无新增依赖、安装体积和云端费用不变；OBS 与虚拟音频驱动仍作为独立前置组件，仅在用户明确触发安装时提权。用户数据继续位于 `%APPDATA%`，与程序安装和升级目录隔离。

# 2026-08-12：移除桌面端默认菜单栏

- 调研：Electron 43 官方 `BrowserWindow` API 在 Windows 支持 `removeMenu()`、`setMenuBarVisibility()` 和自动隐藏菜单；自动隐藏后用户仍可按 Alt 唤出菜单。
- 采用：创建主窗口后调用 `removeMenu()`，彻底移除 `File / Edit / View / Window` 默认菜单。应用所需功能均由页面内控件提供，不要求用户配置 Electron 菜单。
- 兼容与成本：复用现有 Electron API，不新增依赖、安装体积、运行资源、云端费用或数据传输；保留原生标题栏和最小化、最大化、关闭按钮。

# 2026-08-12：桌面标题栏视觉融合

- 调研：Electron 43 官方支持 `titleBarStyle: "hidden"` 与 `titleBarOverlay`，可在 Windows 保留系统窗口按钮和原生窗口行为，同时由应用指定标题区颜色、图标颜色及高度；页面可使用 `titlebar-area-height` 环境变量避让覆盖区域。
- 采用：将标题区收窄为 36px，使用与应用导航一致的深色背景和高对比浅色窗口按钮；页面仅在 Window Controls Overlay 生效时自动增加顶部安全区，不影响普通浏览器布局。
- 未选择：不使用完全无边框窗口和自制最小化、最大化、关闭按钮，以免增加 IPC 权限面、缩放适配和 Windows Snap 行为的维护成本。
- 兼容与成本：复用 Electron 与 Chromium 标准能力，无新增依赖、资源文件、网络请求或用户配置；保留 Windows 拖动、双击最大化、Snap 和系统按钮语义。
- 视口修正：全屏数字人舞台使用 `100dvh - titlebar-area-height` 作为可用高度，并使用 `width: 100%`，避免标题区与 `100vh` 叠加产生无意义滚动条；普通长内容页面仍保留按需滚动。
- 首页布局：桌面宽度下改为会话设置、核心对话、会话工具三栏固定工作区，页面本身不滚动；长对话、设置表单和辅助工具仅在各自面板内部按需滚动。工作台宽度使用 `min(1800px, 100% - 32px)`，全屏/最大化时中间对话栏随视口拉伸；窗口窄于 1280px 时恢复自然文档流，避免压缩可用内容。

# 2026-08-13：RTC 与实时字幕改由后端配置

- 采用：桌面设置页不再展示 RTC AppID、鉴权模式、Token 服务地址、临时 Token、房间、用户和字幕语言配置；设置项重新连续编号。
- 运行边界：实时字幕和会议音频功能继续使用现有服务端 `/api/rtc/token` 与 `lib/rtc-settings.ts` 配置链路，客户端只消费后端签发的短期连接信息。
- 安全与成本：不新增依赖、网络服务或数据流；减少终端用户接触基础设施配置和敏感鉴权信息的机会。后端配置接口暂时保留，以兼容已有部署与管理流程，但不再从桌面 UI 暴露。

# 2026-08-13：OBS 自动安装连接与麦克风授权

- OBS：复用现有固定 OBS 32.2.1 便携资源、SHA-256 校验、官方签名校验和 UAC 组件注册流程，不新增安装依赖。桌面端分别检测 OBS 是否随包存在及 Virtual Camera 是否已注册；缺少系统注册时提供“管理员授权注册并连接”，完成后以持久随机 WebSocket 密码启动专用 OBS，自动配置舞台和虚拟摄像头。
- 麦克风：Electron 43 官方要求同时实现 `setPermissionCheckHandler` 与 `setPermissionRequestHandler`。仅允许当前随机回环地址的应用页面请求 `media` 权限，其余来源和权限继续拒绝；页面按钮在一次用户操作中发起授权并执行设备与信号检测。
- Windows 边界：不修改注册表、组策略或全局隐私开关。若用户或管理员已关闭桌面应用麦克风访问，应用通过微软官方 `ms-settings:privacy-microphone` URI 打开系统设置，由用户确认授权。
- 设置顺序：系统诊断移动到第一项，优先展示阻断状态；OBS、音频和会议确认仍按依赖顺序排列。
- 重试上限：OBS 自动连接按 500 毫秒间隔轮询，冷启动总时限固定为 30 秒；耗尽后停止自动尝试并恢复操作按钮，只在用户再次点击时启动新一轮，避免长期后台重连。

# 2026-08-13：一体化便携 OBS 与虚拟声卡

- OBS 发行物：继续固定官方 OBS Studio 32.2.1（GPL-2.0-or-later），由安装器 EXE 改为官方 Windows x64 ZIP。GitHub 官方发布 API 给出的 ZIP 大小为 187,817,017 字节，SHA-256 为 `db64a2934f8261f85b1410b84be011207a0afda5400d008289f1f1e211bcc7de`；构建阶段同时验证其中 `obs64.exe` 的 OBS Project Authenticode 签名。
- 隔离方式：采用 OBS 官方 `--portable`，并固定 `--only-bundled-plugins`、`--disable-updater`、`--disable-missing-files-check`、`--minimize-to-tray`。安装包内的 OBS 只作为已校验模板，首次运行复制到客户端用户数据目录的可写运行目录，避免读取 `%APPDATA%\\obs-studio`，也避免在 Program Files 中写便携配置。
- 生命周期：复用现有 `obs-websocket-js 5.0.8`（MIT）在 Electron 主进程进行认证、场景配置、Virtual Camera 和麦克风路由控制；客户端只启动自己运行目录内的 OBS。外部 `obs64.exe` 存在时仅提示关闭，不终止、不修改用户配置。冷启动最多等待 30 秒，并按配置、进程、端口、认证、场景、虚拟摄像头分类失败。
- 系统组件：继续复用 Virtual Audio Driver 25.7.14（MIT/MS-PL）签名发布物和 Windows 自带 `pnputil`，不自行开发音频驱动；OBS Virtual Camera 使用官方内置模块。预览版与 NSIS 安装器复用同一 PowerShell 注册逻辑：提权前后都验证 32/64 位模块固定 SHA-256 与 `OBS Project, LLC` Authenticode 签名，再使用相应位数 `regsvr32`，最后核对两个注册表视图；UAC 取消、签名/哈希错误和注册失败返回稳定错误码。
- 安全与数据：WebSocket 长期随机密码的主副本用 Electron `safeStorage`/CurrentUser DPAPI 加密，并按 OBS 上游要求存在专用配置的明文字段；不经命令行、渲染 IPC 或日志。专用 OBS 仅访问随机回环地址舞台。无新增云端服务、API 成本或候选人数据流，也不创建防火墙例外。
- 体积与限制：安装包增加约 188 MB（压缩前还包括解压后的 OBS 文件与驱动资源）。Windows 驱动签名策略、UAC 和重启要求无法由应用绕过；Virtual Camera 和虚拟声卡最终状态仍需 Windows 10 2004+/Windows 11 x64 实机安装测试。

# 2026-08-14：虚拟摄像头状态协调与素材上传提示

- OBS：继续复用现有 `obs-websocket-js 5.0.8` 和 OBS WebSocket 的 `StartVirtualCam`、`StopVirtualCam`、`GetVirtualCamStatus`，不新增依赖。启动或停止命令即使先返回错误，也以最长 2 秒内轮询得到的最终输出状态为准，避免 OBS 异步完成操作时被客户端误报失败。
- 素材选择：继续使用浏览器原生文件输入；`accept` 只改善文件选择体验，服务端仍校验真实 MIME、文件头和 50MB 大小上限。前后端共享 JPEG、PNG、WebP、MP4、WebM 策略，界面直接说明推荐 16:9、1280×720、视频静音循环和仅本机保存。
- 成本与安全：无新增包、网络服务、云端费用或数据流；素材仍只保存在本机 `data/avatar`，OBS 密码与现有安全边界不变。

# 2026-08-14：Go 控制 API 基础设施

- 目标与边界：为现有 Windows Electron/Next.js 客户端旁新增本机 Go 控制 API 的最小骨架。本任务仅提供配置、健康检查和 OpenAPI 占位定义；不改动现有客户端行为，不接入认证、普通用户、AI、RTC、候选人数据或数据库。
- Go 1.26.5：使用指定 Go 工具链和标准 `net/http` 服务器生命周期。[官方发布历史](https://go.dev/doc/devel/release)记录其发布于 2026-07-07，并包含 `crypto/tls` 与 `os` 安全修复。它在 Windows 上原生可构建，浏览器和 OBS 无运行时耦合；不会引入云端服务、GPU/CPU 后台进程、内存常驻组件或按量 API 成本。
- `github.com/go-chi/chi/v5 v5.3.1`：MIT。[官方发布页](https://github.com/go-chi/chi/releases/tag/v5.3.1)记录 2026-07-06 发布并标记为 Latest；它直接提供请求 ID、恢复和超时中间件，选择它而非自行编写中间件链，保持后续 API 路由可组合且接入量小。运行时只增加小型 Go 路由代码，不访问外部服务或处理密钥。
- `github.com/jackc/pgx/v5 v5.10.0`：MIT。[官方发布页](https://github.com/jackc/pgx/releases/tag/v5.10.0)记录 2026-06-03 标签活动；它是 PostgreSQL Go 驱动和工具集，为后续数据库接入预先锁定。本任务不建立连接、不读取或写入候选人数据；它与 Windows Go 构建兼容，不影响浏览器或 OBS。
- `golang.org/x/crypto v0.54.0`：BSD-3-Clause。[Go 官方包元数据](https://pkg.go.dev/golang.org/x/crypto@v0.54.0)确认版本与许可证；该补充密码学包为后续服务端凭据处理预先锁定，本任务的依赖锚点只引用 `bcrypt`，不实现认证、不处理密码或令牌。其为纯 Go 依赖，无浏览器、OBS、GPU 或付费 API 影响；密钥只允许在未来由服务端环境变量读取，禁止写入源码、日志或版本库。
- `github.com/pressly/goose/v3 v3.27.3`：MIT。[官方发布页](https://github.com/pressly/goose/releases/tag/v3.27.3)记录 2026-07-22 发布并标记为 Latest，检查时主分支在该发布后仍有提交；它为后续显式迁移流程预先锁定。本任务不创建数据库、迁移或数据模型，它不会成为常驻服务组件，不影响 Windows、浏览器或 OBS。
- 锁定方式：`internal/dependencies/tools.go` 使用 `tools` 构建标签和空导入保存尚未启用的 pgx、x/crypto、goose 模块引用；`go mod tidy` 会保留精确版本，但正常构建和运行时不会链接它们。这是比在运行时代码中空导入更小、且不扩展本任务功能范围的常规 Go 依赖锚点。
- 部署体积证据：使用指定 Windows/amd64 Go 1.26.5 执行 `go build -o $env:TEMP\control-api-task-1.exe ./cmd/control-api`，未压缩可执行文件实测为 10,151,936 字节；这是本任务的运行时部署增量。pgx、x/crypto 和 goose 仅存在于带 `tools` 标签的依赖锚点，不进入该正常构建产物；其模块下载与源码缓存属于开发/CI 磁盘成本，不是服务器部署体积。
- 维护与安全审查（检查日 2026-08-14）：Go 官方已于 2026-08-13 发布含 `net/http` 等安全修复的 1.26.6；本任务因明确版本约束仍锁定 1.26.5，但部署前必须升级并重跑测试。Go 漏洞库 [GO-2026-5774](https://pkg.go.dev/vuln/GO-2026-5774)、[GO-2026-5775](https://pkg.go.dev/vuln/GO-2026-5775) 仅影响 chi 5.3.0 之前版本，当前 5.3.1 不在范围；[GO-2026-4771](https://pkg.go.dev/vuln/GO-2026-4771) 仅影响 pgx 5.9.0 之前版本，当前 5.10.0 不在范围；[GO-2026-5033](https://pkg.go.dev/vuln/GO-2026-5033) 仅影响 x/crypto 0.52.0 之前版本，当前 0.54.0 不在范围。[GO-2026-5932](https://pkg.go.dev/vuln/GO-2026-5932) 指出所有版本的 `x/crypto/openpgp` 均不安全且不再维护，因此禁止后续引入该子包；当前只锚定 `bcrypt`。当前健康接口不包含数据库 URL 或其他配置值；后续启用预锁定依赖时必须重新检查官方发布、安全公告、数据流向和资源成本。
- 未采用 Ory Kratos：其覆盖注册、账户恢复、MFA、OIDC 和多租户身份能力，均超出本阶段范围；引入它会增加独立服务、运行资源、配置和维护面，故本阶段明确不接入。

# 2026-08-14：Go 控制 API 身份数据库迁移

- 目标：在启动时以 PostgreSQL 16+ 创建并升级用户、可撤销会话、设备和审计 schema；复用 Task 1 已锁定而未链接到运行时的直接依赖，Go 1.26 额外记录 pgx 所需的间接池依赖，不新增功能重叠的包。迁移嵌入 Go 二进制，避免生产环境依赖工作目录中的 SQL 文件。
- `github.com/jackc/pgx/v5 v5.10.0`：MIT；官方模块与发布页显示其为活跃维护的 PostgreSQL 驱动，且 Task 1 的安全审查确认已规避仅影响 5.9.0 之前的 GO-2026-4771。使用其 `pgxpool` 和标准库适配层，而非自行实现 PostgreSQL 协议或再引入 ORM。它是纯 Go、原生兼容 Windows 和本项目指定 Go 1.26.5，不运行于浏览器或 OBS；运行时最大 10 个数据库连接，CPU/内存开销受此上限约束，无 GPU 或付费 API 成本。数据库 URL 只从进程环境读取，错误、日志和测试报告均不得回显 URL 或其中的凭据。
- `github.com/jackc/puddle/v2 v2.2.2`：MIT；这是 pgx v5.10.0 官方 `go.mod` 指定的间接资源池，Go 1.26 在实际导入 `pgxpool` 后将其写入模块图。它提供 pgx 所需的并发安全池实现，本项目不直接调用其 API，不能移除或替换；纯 Go、兼容 Windows/Go 1.26.5，且仅随最多 10 条连接的 pgx 池运行，无浏览器、OBS、GPU、云端或按量成本。其代码不接收数据库 URL，凭据仍只进入 pgx 的进程内连接配置。
- `github.com/pressly/goose/v3 v3.27.3`：MIT；官方 Go package 元数据确认带标签的可再分发稳定版本，官方发布页显示 2026-07-22 发布且项目仍维护。采用其官方 `SetBaseFS` 嵌入 SQL 迁移支持及 PostgreSQL 方言，避免自写 migration history/并发升级机制；它只在启动迁移时运行，不产生浏览器、OBS、GPU、云端或按量 API 成本。Task 1 已审查其版本与维护状态；本任务未发现新的已知安全公告，发布前仍须执行依赖漏洞扫描。
- 未采用 SQLite、mock 或自写迁移器：身份 schema 依赖 PostgreSQL enum、JSONB、`bytea` 和生产目标的一致语义；替换会降低约束覆盖，不能验证真实迁移。测试仅在显式提供 `TEST_DATABASE_URL` 时连接一次性 PostgreSQL，未提供时明确跳过，不传输任何候选人数据或密钥。
- 体积、兼容性与维护：pgx 和 goose 已存在于 `go.mod`/`go.sum`；实际导入 `pgxpool` 后，Go 1.26 将 pgx 指定的 `puddle/v2` 写入间接依赖清单，但不新增服务或云端费用。本任务会在 Go 1.26.5 Windows/amd64 上构建和 vet。自动迁移要求最小权限数据库用户具备 schema 变更权限；多实例同时启动的迁移锁和生产数据库备份/恢复流程留待容器与运行文档任务明确。

# 2026-08-14：Go 控制 API 用户、会话与审计存储

- 目标：实现 PostgreSQL 用户、可撤销不透明会话和追加式审计写入；只持久化 Task 3 已生成的编码密码哈希，不在本层处理明文密码，也不实现 HTTP 或身份编排服务。
- 采用：继续复用已锁定的 `github.com/jackc/pgx/v5 v5.10.0`（MIT）及 Go 1.26.5 标准库 `crypto/rand`、`crypto/sha256`、`crypto/subtle`、`encoding/base64` 和 `encoding/json`，不新增依赖。pgx 官方文档提供 `Exec`、`Query`、`QueryRow` 的参数绑定接口，且 `pgx.Tx` 实现相同方法，因此用最小 `database.DBTX` 适配池与事务；官方 5.10.0 变更记录显示 2026-06-03 发布并包含针对恶意或受控 PostgreSQL 服务端的协议和认证加固，仓库在检查日仍有发布后的维护提交。
- 未采用：不引入 ORM、会话框架、身份平台或审计 SDK。当前 schema 和查询数量小，现有 pgx 已完整覆盖参数化 SQL 与事务复用；额外框架会增加二进制体积、供应链和迁移维护面。令牌 ID、SHA-256 摘要、五分钟节流和 metadata denylist 属于短小且安全边界明确的领域逻辑，标准库已提供所需密码学原语；不复制第三方源码。
- 安全与数据：32 字节随机会话令牌仅返回一次，数据库只保存 SHA-256 摘要并在索引查询后进行恒定时间比较；SQL 全部使用位置参数。审计 metadata 在 JSON 编码前拒绝大小写不敏感的敏感键。数据库 URL 仅由测试/进程环境提供，测试使用随机隔离 schema，缺少 `TEST_DATABASE_URL` 时明确跳过，不使用 mock 或 SQLite。
- 兼容、资源与成本：纯 Go/pgx 方案兼容指定 Windows Go 1.26.5 和 PostgreSQL 16+，不进入浏览器或 OBS，不需要 GPU、外部进程或付费 API；运行时沿用已有最多 10 个连接的池上限，只增加小型查询与少量随机/哈希计算。已知限制是本机没有 PostgreSQL URL 时无法执行真实集成路径；上线前仍需升级已知含标准库安全修复的 Go 1.26.6，并重新运行漏洞扫描和 PostgreSQL 集成测试。

# 2026-08-14：Go 控制 API 管理员命令行与身份编排

- 目标：提供一次性初始管理员创建和管理员密码重置，继续复用已有 Argon2id、pgx 事务、用户、会话和追加式审计存储；初始化只创建 `admin`，不创建普通客户端用户，也不提供注册或密码参数/环境变量入口。
- 终端输入采用：`golang.org/x/term v0.45.0`（BSD-3-Clause）。[Go 官方包元数据](https://pkg.go.dev/golang.org/x/term@v0.45.0)记录该标签发布于 2026-07-08，由 Go 项目持续维护，`ReadPassword` 在真实终端上关闭本地回显，`IsTerminal` 支持 Windows 文件描述符判定。2026-08-15 检查 [Go 官方 `x/term` 仓库](https://go.googlesource.com/term.git)时，`master` 页面展示的标签为 `v0.45.0`；同日 `pkg.go.dev` 的 `v0.45.0` 包页面却提示该页面不是最新模块包视图。由于两个官方视图存在差异，且本地 `go list -m -json golang.org/x/term@latest` 因代理超时失败，本记录不声称已经确定全局最新版本；在没有权威的新标签证据前继续锁定已验证的 `v0.45.0`，发布前重新核对官方标签并执行漏洞扫描。使用官方独立模块，不使用已废弃并迁移到它的 `x/crypto/ssh/terminal`，也不自行维护 Windows Console API 及 Unix termios 分支。
- 兼容、体积与成本：`x/term` 是纯 Go/平台系统调用适配，兼容本项目 Go 1.26.5 与 Windows；不运行于浏览器或 OBS，不引入 GPU、常驻进程、网络服务或付费 API。它只链接到短命管理 CLI，部署体积影响在最终容器任务中实测；无单独内存或 CPU 后台开销。
- 安全与数据：密码仅从交互终端或两行标准输入读取，不进入命令行、环境变量、标准输出或日志；空值和不匹配确认在连接数据库前失败。检查 Go 官方问题跟踪器中的未解决终端问题时，确认 [golang/go#19909](https://github.com/golang/go/issues/19909) 仍讨论 `ReadPassword` 对重定向标准输入返回 ioctl 错误；本 CLI 在调用前先用 `IsTerminal` 分流，对管道/文件改用有界的两行 scanner，因此不依赖该未解决行为。检查日未在 Go 漏洞库中找到直接影响 `x/term v0.45.0` 的公告；发布前仍须对完整模块图执行 `govulncheck`。身份变更、会话撤销与审计写入在同一 pgx 事务内，任一步失败即回滚。

# 2026-08-15：Go 控制 API 登录、会话中间件与登录限流

- 目标与边界：实现登录、退出、当前用户和按用途隔离的会话中间件。浏览器只接受 `control_session` Cookie，桌面端只接受 Bearer Token；失败响应不暴露用户是否存在、密码哈希、令牌、数据库 URL 或原始内部错误。本任务不增加注册、找回密码、MFA、OIDC、普通用户初始化、AI/RTC 或候选人数据处理。
- 复用方案：继续使用已锁定的 `github.com/go-chi/chi/v5 v5.3.1`（MIT）请求 ID/路由中间件、`github.com/jackc/pgx/v5 v5.10.0`（MIT）事务、`golang.org/x/crypto v0.54.0`（BSD-3-Clause）Argon2id，以及 Go 1.26.5 标准库 `net/http`、`encoding/json`、`net/netip`、`crypto/sha256` 和 `sync`。Go 官方 `net/http.MaxBytesReader` 会在越界时返回 `MaxBytesError` 并限制恶意请求资源消耗；JSON Decoder 提供未知字段拒绝和单值解析能力。现有依赖均为纯 Go 或当前项目已验证的 Windows/服务器依赖，不接触浏览器或 OBS，不需要 GPU、外部服务或付费 API。
- 限流方案调查：Go 官方 `golang.org/x/time/rate` 提供并发安全的 token bucket，`v0.15.0` 包页面记录 BSD-3-Clause、2026-02-11 发布和大量下游使用；但页面同时提示该版本不是模块最新视图，而本机访问官方 Go module proxy 超时，无法可靠确认并下载当前最新标签。即使采用它，本项目仍必须自行实现“规范化用户名 + 规范 IP”键、可信代理 CIDR 边界和 30 分钟条目淘汰。为避免在无法完成版本与模块校验时扩展供应链，本任务不新增该模块，而用标准库实现只包含令牌补充、容量和淘汰的最小同步结构；后续若需要跨实例共享或分布式限流，应改用服务器侧共享存储，而不是继续扩展内存实现。
- 安全与代理边界：默认只信任 TCP 直连地址；仅当直连 peer 命中显式 `TRUSTED_PROXY_CIDRS` 时才读取代理转发地址，并对地址使用 `netip` 解析/规范化。限流键和失败审计只保存规范化用户名及来源 IP，不保存密码、Token、Authorization 或 Cookie。内存桶最多突发 10 次、按五分钟补充五次额度，30 分钟无活动后淘汰；它是单进程防爆破层，不替代反向代理或共享存储限流。
- 体积、维护与限制：无新增模块，部署增量仅为少量标准库可达代码和每个活跃登录键一个小型内存条目；无云端费用或额外数据去向。当前 Go 1.26.5 已知落后于带标准库安全修复的 1.26.6，发布前仍须升级工具链、执行 `govulncheck`、在带 C 编译器的 CI 跑 `-race`，并在显式提供 `TEST_DATABASE_URL` 的隔离 PostgreSQL 上验证事务回滚、会话撤销和审计原子性。

# 2026-08-15：Go 控制 API 生产容器与本地 Compose

- 目标：为 `server/control-api` 提供可复现的非 root 镜像、仅回环的开发 Compose、部署文档和可选容器冒烟测试；不改动 Electron/Next.js 行为，不新增与 chi/pgx/goose 重叠的运行时库。
- 构建镜像：官方 [`golang:1.26.5-alpine`](https://hub.docker.com/_/golang)。[Docker Hub 官方标签](https://hub.docker.com/_/golang)在检查日将 `1.26.5-alpine` 作为 `1.26.5-alpine3.24` 的共享标签；许可证为 Go BSD-3-Clause，Alpine 基础系统为 MIT。官方文档给出 `COPY go.mod go.sum` 后 `go mod download` 再复制源码的缓存顺序，以及 `CGO_ENABLED=0` 静态编译。选择 alpine 构建器而不是完整 Debian `golang:1.26.5`，是为了缩小构建层；最终运行时不保留该构建器。
- 运行镜像：[`gcr.io/distroless/static-debian12:nonroot`](https://github.com/GoogleContainerTools/distroless)（Apache-2.0）。官方 README 将 `static-debian12` 列为无 shell、无包管理器的静态 Go 运行时，并提供 `:nonroot` 标签；ENTRYPOINT 必须使用 JSON 向量形式。未采用 `scratch`（缺少 CA/时区与非 root 用户元数据）、未采用 `alpine`/`debian` 运行时（含 shell 与包管理器，攻击面更大）、也未采用更重的 K8s/Helm/Ory 栈。Debian 13 变体存在，但本任务按计划锁定 `static-debian12:nonroot`。
- 数据库：官方 [`postgres:16`](https://hub.docker.com/_/postgres)（PostgreSQL License）。Compose 使用命名卷、`pg_isready` 健康检查，并将 API/`5432` 发布限制在 `127.0.0.1:8080` 与 `127.0.0.1:54329`。未采用 SQLite 或自建 Postgres 镜像，以免偏离已锁定的 PostgreSQL 16+ schema。
- Compose：官方 Compose 规范的 `depends_on.condition: service_healthy`、`127.0.0.1` 端口绑定、`profiles` 一次性服务和项目目录 `.env` 变量替换。`COOKIE_SECURE=false` 仅用于本地 HTTP；生产文档要求 TLS 与 `COOKIE_SECURE=true`。`.env.example` 只有占位符，真实 `.env` 不入库。
- 未采用：完整 Kubernetes、Istio、Ory Kratos、第二套反向代理镜像或额外健康检查二进制。当前是本机开发栈加一份可部署静态镜像；更重的编排会增加运行资源、密钥面和维护成本。
- 限制：本机若未安装 Docker，则无法执行 `docker compose config/build/up` 和容器冒烟；Windows 无 C 编译器时 `go test -race` 不可用。发布前仍须在有 Docker 与 GCC 的环境补跑这些命令。

# 2026-08-15：管理后台登录与用户管理网页

- 目标：给已完成的 Go control-api 提供浏览器管理控制台，覆盖登录/退出和用户创建、禁用、重置密码、撤销会话；不包含公开注册、AI/RTC 配置或候选人数据。
- 采用：与现有面试客户端相同大版本的 [Next.js](https://github.com/vercel/next.js) `^15.4.0`（MIT）和 React `^19.1.0`（MIT），独立应用放在 `server/management-web`，避免把 OBS/舞台/面试控制台与管理后台混在同一个 Next 应用里。
- 接入：官方 App Router 与 `next.config` `rewrites`，把浏览器 `/api/v1` 代理到 `CONTROL_API_ORIGIN`，从而保持 `control_session` 的 first-party Cookie，不新增 CORS 库、状态管理库或 UI 套件。
- 未采用：在现有面试 Next.js 应用中加 `/admin` 路由（会把管理后台和 Windows 专属能力缠在一起）；未采用独立身份 SaaS。
- 安全：密码与会话令牌不写入 localStorage/sessionStorage/日志；无注册入口；operator 登录后不能使用管理 API。
- 限制：本机无 Docker 时不验证管理端容器；生产仍须 TLS 与 `COOKIE_SECURE=true`。

# 2026-08-15：管理端个人服务器 HTTP:80 部署

- 目标：在个人 Ubuntu 服务器上部署管理后台，浏览器从 80 端口访问；不改管理端业务代码。
- 采用：复用已有 `server/control-api` 与 `server/management-web` 官方镜像构建，以及官方 [`postgres:16`](https://hub.docker.com/_/postgres)（PostgreSQL License）和 [`nginx:1.27-alpine`](https://hub.docker.com/_/nginx)（2-clause BSD）。Nginx 只反向代理管理前端，PostgreSQL 与 Go API 不发布到公网端口。
- 原因：设计文档已选择 Caddy 或 Nginx 做反向代理；用户明确要求前端走 80。现有开发 Compose 只绑定 `127.0.0.1:3001`，不能直接作为公网入口。
- 未采用：Caddy 自动 HTTPS（会把 80 跳到 443，与“前端用 80 口”冲突）；未把宿主机已有公网 `5432` PostgreSQL 当作应用库（该实例对 `0.0.0.0` 开放，且与容器网络隔离目标不一致）。
- 限制：当前按用户要求使用明文 HTTP，因此 `COOKIE_SECURE=false`。没有 TLS 时会话 Cookie 可被网络侧截获；上线公网前应改为 443 并恢复 `COOKIE_SECURE=true`。

# 2026-08-16：管理端在线状态、当前线路与 AI/RTC 配置入库

- 目标：让管理后台能看到账户在线、当前会话线路，并允许管理员通过网页把 AI/RTC 配置写入 PostgreSQL；密钥不回传到前端。
- 采用：继续复用已锁定的 Go 标准库 `crypto/aes` + `crypto/cipher` GCM、`net/http` 探测 OpenAI-compatible `GET /models`、chi/pgx/goose、以及现有 Next.js 管理端。不新增 UI 套件、ORM、AI SDK 或 RTC Token SDK。
- 加密：`SETTINGS_MASTER_KEY` 为 32 字节 hex 主密钥，只存在进程环境；数据库只保存 AES-256-GCM 密文和密钥版本。读取接口只返回 `apiKeyConfigured` / `secretConfigured`。
- 在线判定：复用已有 `user_sessions.last_used_at`（5 分钟节流更新）和未撤销未过期会话；15 分钟内有活动视为在线。不引入 WebSocket。客户端心跳和设备上报仍属后续阶段，当前线路以活动会话为准。
- 未采用：Ory、Vault SDK、Volcengine Token SDK。本阶段只保存和测试配置，不把远程 AI 追问或 RTC Token 签发切到 Go。
- 限制：没有主密钥时仍可查看空配置和用户在线，但不能保存密钥；Windows 客户端尚未登录/心跳时，desktop 线路不会出现。

# 2026-08-16：腾讯云 COS 简历上传

- 目标：Windows 客户端上传候选人简历，文件保存在腾讯云对象存储；管理端保存 COS 配置并查看/下载简历。密钥不进客户端、前端源码或 Git。
- 采用：官方 [tencentyun/cos-go-sdk-v5](https://github.com/tencentyun/cos-go-sdk-v5) `v0.7.59`（Apache-2.0）。管理 API 用该 SDK 列出 Bucket、PutObject 和预签名下载。
- 存储：`object_storage_configs` 保存地域、Bucket、SecretId，SecretKey 继续用已有 AES-256-GCM `SETTINGS_MASTER_KEY` 加密。`resumes` 只存元数据和 object key。
- 客户端：本地 Next.js `/api/resume` 用桌面会话 Bearer 转发到 control-api，不接触云密钥。仅接受 PDF/Word，最大 10MB。
- 未采用：在 Electron 里接入 `cos-js-sdk-v5`（会把密钥或临时密钥下发到桌面）；未采用 MinIO/AWS SDK，因为当前明确是腾讯云 COS。
- 限制：需要先在腾讯云创建 Bucket 并在管理后台填写地域/桶名。密钥曾在聊天中明文提供，上线后应在腾讯云轮换 SecretKey。

# 2026-08-16：客户端查看、删除并重新上传简历

- 目标：Windows 客户端登录后能看到自己已上传的简历，打开原文件，删除后重新上传；管理后台同步支持删除。
- 采用：复用已接入的官方 [tencentyun/cos-go-sdk-v5](https://github.com/tencentyun/cos-go-sdk-v5) `Object.Delete`（Apache-2.0）和现有预签名 `Get`。不新增 SDK、不把 COS 密钥下发到客户端。
- 权限：客户端 `GET/DELETE /api/v1/client/resumes` 只操作当前账号上传的文件；管理员走 `/api/v1/admin/resumes` 可查看全部并删除。对象不存在时按官方 `cos.IsNotFoundError` 视为已删除，再删元数据，便于重试。
- 未采用：前端直连 COS、静默覆盖旧文件、引入新的文件预览组件。PDF 用浏览器打开预签名链接；Word 由浏览器下载。
- 限制：查看依赖 COS 预签名 URL（1 小时有效）；删除后索引/知识库若后续接入需另行清理。

# 2026-08-16：火山 RTC 与 LiveKit 双线路，共用字幕 v1

- 目标：候选人仍走腾讯会议/飞书。字幕 UI 只消费 `ai.interviewer.subtitle.v1`。管理端按压力在火山云 RTC 与自建 LiveKit 之间切换，两边配置都保留。
- 字幕契约：客户端 `lib/subtitles` 的 Sink 是唯一入口。火山 `sequence`/`definite` 和 LiveKit segment/data packet 只存在映射器。不新增 UI 套件。
- 火山线路：继续官方 [`@volcengine/rtc` 4.69.0](https://www.npmjs.com/package/@volcengine/rtc)（BSD-3-Clause）和 `startSubtitle`。不删除 SDK。
- LiveKit 线路：官方 [`livekit-client`](https://www.npmjs.com/package/livekit-client)（Apache-2.0）推 PCM；自建镜像 [`livekit/livekit-server`](https://github.com/livekit/livekit)（Apache-2.0）；字幕 Agent 用官方 Python [`livekit-agents`](https://github.com/livekit/agents) + `livekit-plugins-openai` 调远程 OpenAI-compatible STT，经 data topic `subtitle.v1` 回写 v1 JSON。
- Token：Go control-api 用标准库 HMAC-SHA256 签发 LiveKit JWT，不引入 `server-sdk-go`（会带入 pion/WebRTC，对只签发 Token 明显过重）。火山正式模式仍请求已配置的 HTTPS Token 服务。
- 未采用：同机 FunASR/whisper 作为 LiveKit STT；删除火山 RTC；把两家字段混在一个表单。
- 限制：4 核 8G 可合部 SFU + 轻量 Agent + 管理栈，前提是 STT 走远程 API。公网需要 UDP/TURN 与 TLS；当前管理入口仍可走 HTTP 80，LiveKit 默认不启动（compose profile `livekit`）。默认 `activeProvider=volcengine`。

# 2026-08-16：客户端独立登录页

- 目标：把工作台「候选人简历」里的账号/密码表单移走，改成独立登录界面。
- 采用：复用现有 Next.js App Router 的 `/login`、已有 `/api/control-session` Cookie 会话，以及管理后台登录页的布局节奏。不新增 UI 套件、状态管理库或身份 SDK。
- 原因：设计文档已要求客户端有独立登录窗口；在简历卡片里塞登录表单会把鉴权和上传混在一起。
- 未采用：把整个工作台强制跳到登录页（本地互动、设置和舞台仍可离线使用）；未改 Electron `safeStorage` 会话（仍走本机 httpOnly Cookie）。
- 限制：登录只连接管理端客户端账号；管理后台继续用 `server/management-web` 的管理员登录页。
- 登录失败：客户端只显示「登录失败」，不转发管理 API 的英文原文。桌面登录暂不发送 `deviceId`，因为设备登记尚未实现；若带上未登记的固定设备 ID，新建客户端账号即使用对密码也会被当成凭证错误。
- 管理员保护：当前登录的管理员不能禁用自己；最后一位启用中的管理员也不能被禁用。用户列表「状态」列不再叫「账号」，避免和登录用户名混淆。

# 2026-08-16：AI 模型改为管理端配置

- 目标：Windows 客户端不再提供 AI 模型设置表单；地址、模型名和 API Key 只在管理后台配置。
- 采用：复用已有管理端 `/settings/ai`、PostgreSQL 加密存储和 `GET /models` 探测。客户端登录后由本机 Next 服务用桌面会话向 `GET /api/v1/client/settings/ai` 拉取运行时配置；密钥只留在本机 Node 内存，不写 `model.json`、不回传到浏览器。
- 未采用：把追问/纪要 HTTP 调用整段迁到 Go（当前 llm.ts 已能工作）；未删除本机环境变量/旧 DPAPI 回退，避免未登录或管理端暂不可达时完全不能跑本地冒烟。
- 限制：该客户端接口需部署新版 control-api 后才生效。浏览器管理会话不能读取 API Key。

# 2026-08-16：语音转写改由管理端下发，客户端展示网络质量

- 目标：客户端不再配置本地 whisper/OpenAI 转写；转写地址、模型和密钥与 AI 一样由管理端提供。同时让操作员在客户端看到管理端延时，以及实时字幕线路的丢包。
- 采用：复用管理端 RTC 页已有的 ASR 字段和 AES-256-GCM 存储。新增桌面专用 `GET /api/v1/client/settings/asr`，密钥只进本机 Node 内存。未单独配置 ASR 时回退到管理端 AI 的 OpenAI-compatible 地址。网络延时用已有 `CONTROL_API_ORIGIN/healthz` 往返；丢包/线路 RTT 用官方 [`livekit-client`](https://www.npmjs.com/package/livekit-client) 的 `getRTCStatsReport` / `RTCRtpSender.getStats`，以及火山 [`@volcengine/rtc`](https://www.npmjs.com/package/@volcengine/rtc) 的 `getStats`。不新增探测库或 UI 套件。
- 未采用：在客户端保留 whisper.cpp 配置表单；用 ICMP ping 测丢包（浏览器不可用，且与 WebRTC 线路无关）；把转写 HTTP 整段迁到 Go。
- 限制：丢包数字要在启动实时字幕、WebRTC 连通后才有。未登录或新 ASR 接口未部署时，本机环境变量/whisper 仍可作冒烟回退。浏览器管理会话不能读取 ASR 密钥。

# 2026-08-16：简历知识库 RAG（local-pgvector）

- 目标：上传简历后异步索引，追问时按 `resumeId` 检索经历片段并注入 `generateNextQuestion`。检索失败或未就绪时继续提问，不挡面试。
- 稳定面：HTTP `POST /api/v1/client/knowledge/search` 与 Go `knowledge.Provider`。一期只实现 `local-pgvector`；换云知识库或 RAGFlow 时只加适配器，不改面试客户端。
- 向量存储：[pgvector](https://github.com/pgvector/pgvector) PostgreSQL 扩展，镜像 `pgvector/pgvector:pg16`（PostgreSQL 许可证）。Go 侧 [pgvector-go](https://github.com/pgvector/pgvector-go)（MIT）通过 `AfterConnect` 注册类型。知识留在管理端库，不在客户端建向量库。
- Embedding（初版）：Compose 内网 [Text Embeddings Inference](https://github.com/huggingface/text-embeddings-inference) `cpu-1.9`（Apache-2.0）加载 [BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3)（MIT，1024 维）。走官方 OpenAI-compatible `POST /v1/embeddings`，不把推理写进 Go 二进制，不映射宿主端口。
- Embedding（2026-08-17 生产落地）：国内拉取 TEI/HF 权重经常失败。改用已缓存的 [michaelf34/infinity](https://github.com/michaelfeil/infinity) `latest-cpu`（MIT）加载同一 `BAAI/bge-m3`；权重经 [ModelScope](https://www.modelscope.cn/) `snapshot_download` 写入 `embedding_model_cache`。Infinity 只提供 `POST /embeddings`，另用 `nginx:1.27-alpine` 服务名 `embedding` 把 `POST /v1/embeddings` 反代过去，control-api 契约不变。
- 解析：PDF 用 [ledongthuc/pdf](https://github.com/ledongthuc/pdf)（MIT）；docx 用标准库 `archive/zip` + `encoding/xml`。`.doc` 标记 skipped；无字层扫描件标记 failed。不接 OCR。
- 切块：自写「章节标题 + 日期经历整段」，每块带 `[候选人 | 章节 | 公司或项目]` 前缀。不用固定字数滑动窗，也不用英文 `.` 当句界。该逻辑关在 `local-pgvector` 适配器内，换供应商后可整段丢掉。
- 未采用：RAGFlow / Dify / WeKnora（独立产品，RAM 或权限模型不合）；langchaingo 整框架（默认滑动窗切块，且再包一层 HTTP/pgx）；chromem-go（向量不进现有 PostgreSQL）；云 embedding（密钥与数据出管理端内网）。
- 限制：CPU embedding 常驻约 2–4GB，bge-m3 权重约 4GB（含 onnx）。维度相同也不能混用向量空间，换模型必须整库重索引。一期不做 rerank、稀疏检索、题库 UI、报告注入或第二套 Provider。Infinity 冷启动含长文本 warmup，约 1–2 分钟后才监听。

# 2026-08-16：真实摄像头与虚拟摄像头二选一

- 目标：虚拟摄像头改为可选。默认用会议软件里的真实摄像头当助手；只有选择 OBS 虚拟摄像头时才输出数字人。
- 采用：复用现有 OBS Virtual Camera、舞台默认 CSS 形象、浏览器 `localStorage` 保存 `real` / `virtual`。不新增虚拟摄像头驱动、上传 SDK 或会议软件自动化。
- 真实摄像头：会议软件选普通摄像头和麦克风；本软件只做字幕、追问和记录。开始门禁只保留管理端已配置的 AI 模型。
- 虚拟摄像头：仍走 OBS 场景、`/stage`、Virtual Camera、虚拟音频和入会确认。不再把上传图片/视频当作硬门禁；默认形象即可，素材上传仅作可选美化。
- 未采用：自研虚拟摄像头；把真实摄像头接到舞台再经 OBS 输出；自动改腾讯会议/飞书的设备选项。
- 限制：本机无法替用户改第三方会议软件里的摄像头选择。真实摄像头路径不替换对方面看到的画面。

# 2026-08-16：豆包语音声音刻录 / TTS / 极速 ASR

- 目标：在桌面客户端用真实麦克风录面试官声音，复刻后用于舞台 TTS；候选人 VAD 切片优先走火山极速转写。
- 采用：官方 OpenSpeech HTTP。复刻 `POST https://openspeech.bytedance.com/api/v3/tts/voice_clone`；TTS `POST .../api/v3/tts/unidirectional` 且 `X-Api-Resource-Id: seed-icl-2.0`；ASR 录音文件极速版 `POST .../api/v3/auc/bigmodel/recognize/flash` 且默认 `volc.bigasr.auc_turbo`（同步、可传音频字节）。鉴权优先 `X-Api-Key`，旧控制台 `AppID` + Access Token 备用。
- 依赖：现有 `fetch`、`MediaRecorder`/`AudioContext`、`getUserMedia`。不引入 `@volcengine/openapi`、Python 示例包或移动 SDK。
- 密钥：管理端 `speech_configs` 用 AES-256-GCM 加密 API Key / Access Token / Secret Key；桌面专用 `GET /api/v1/client/settings/speech` 才下发明文。本机回退 `data/settings/speech.json` + DPAPI，以及 `.env.example` 空模板。Secret Key 只保存，本轮不实现 HMAC。
- 未采用：Piper / CosyVoice（本地模型体积与许可证不适合默认捆绑）；火山移动 SDK；把录音放到管理网页（麦克风在面试官本机）；改 LiveKit Agent STT（协议不兼容，本轮仍走 OpenAI-compatible）。
- 限制：实时字幕仍走现有火山 RTC / LiveKit；复刻音频最长约 25 秒、最大 10MB；后付费自定义 `speaker_id` 首次正式合成可能产生音色槽位费用。

# 2026-08-17：阿里云智能语音交互 TTS / 一句话 ASR

- 目标：把阿里云控制台「智能语音交互」项目接到舞台播报和候选人转写，并做一次真实连通测试。
- 采用：官方 REST。Token 按文档用 HMAC-SHA1 调用 `CreateToken`（`nls-meta.cn-shanghai.aliyuncs.com`，Version `2019-02-28`）；TTS `POST https://nls-gateway-cn-shanghai.aliyuncs.com/stream/v1/tts`；一句话识别 `POST .../stream/v1/asr`。鉴权头 `X-NLS-Token`，Appkey 来自控制台项目。默认音色 `xiaoyun`，WAV / 16 kHz。
- 依赖：现有 `fetch` 与 Node `crypto`。不引入 `alibabacloud-nls`（WebSocket、2023 年后未发版、额外 `ws` 原生依赖）和已进入维护期的 `@alicloud/pop-core` V1 SDK。CreateToken 签名与官方 OpenAPI 文档一致，避免复制 SDK 源码。
- 密钥：只写本机 `.env.local`（`ALIYUN_NLS_APPKEY` / `ALIYUN_NLS_ACCESS_KEY_ID` / `ALIYUN_NLS_ACCESS_KEY_SECRET` 或临时 `ALIYUN_NLS_TOKEN`）。不进前端、不进版本库。配齐后优先于豆包语音用于 TTS/ASR；声音复刻仍走豆包。
- 未采用：DashScope CosyVoice（控制台项目是智能语音交互 NLS，不是百炼 API Key）；管理端 `speech_configs` 本轮不改表，避免把阿里云 AK 误送给火山探测接口。
- 限制：一句话识别 REST 支持 WAV/PCM/OGG-OPUS/MP3/AAC 等，不保证 WebM 容器；自动追问 VAD 切片已是 WAV。项目需在控制台开通语音合成和识别，并启用所用音色。Token 有效期约 24–48 小时，运行时会缓存并提前刷新。

# 2026-08-17：管理端语音双线路与折叠详情

- 目标：管理后台「语音」页能看到并配置阿里云 / 豆包两条线路；平时只显示是否连通，详情可展开收起。
- 采用：沿用 RTC 页「当前线路 + 分卡片」模式，语音页用 `<details>` 折叠；后端 `speech_configs` 增加 `active_provider` 与阿里云字段（迁移 `00008_speech_aliyun.sql`）。探测：豆包仍走 OpenSpeech `get_voice`；阿里云走官方 CreateToken + `/stream/v1/tts`。
- 依赖：不新增 npm/Go SDK；CreateToken 用现有 `crypto/hmac`。管理端密钥仍 AES-256-GCM；桌面 `GET /api/v1/client/settings/speech` 按 `activeProvider` 下发对应明文。
- 未采用：把本机 `.env.local` 自动同步进数据库（需管理员在管理端保存一次，避免静默写密钥）；合并两套密钥到同一表单（易混鉴权）。
- 限制：部署后需跑 goose 迁移；旧库无阿里云列时管理端会显示未连通直到保存。

# 2026-08-17：按登录账号绑定声音刻录

- 目标：客户端声音刻录结果绑定桌面登录用户；该用户 TTS 使用自己的 `speaker_id`。
- 采用：新表 `user_speech_voices`（迁移 `00009_user_speech_voices.sql`）。`PATCH /api/v1/client/settings/speech` 按 session 用户写入；`GET` 下发时用该用户音色覆盖全局默认。不新增 SDK。
- 未采用：把音色写进 `users` 表（语音配置边界应独立）；继续用全局 `speech_configs.speaker_id` 作为唯一音色（多操作员会互相覆盖）。
- 限制：个人复刻音色属于豆包线路。当前线路为阿里云时，舞台合成走系统音色（如 `xiaoyun`），刻录仍可写入账号档案供切回豆包后使用。

# 2026-08-17：账户语音绑定与提交结果可见性

- 目标：管理端账户列表能看到每人是否已绑定音色；客户端提交刻录后能明确看到账号同步成功或失败。
- 采用：复用现有 `user_speech_voices`。`GET /api/v1/admin/users` 合并 `voiceBound` / `speakerId` / `voiceBoundAt`；管理端账户表展示三列。客户端 `saveSpeechSpeakerId` 在 control-api PATCH 失败时抛错，`/api/voice-clone` 返回 `VOICE_BIND_FAILED`，避免「刻录成功但账号未绑定」的假成功。不新增依赖或表。
- 未采用：录音文件落库与克隆任务历史（与当前「只存 speaker_id」模型不一致）；管理端清绑操作（本次仅可见性）。
- 限制：录音本身仍不落库；「提交成功」以账号是否写入有效 `speaker_id` 为准。

# 2026-08-19：虚拟声卡线路自动检测（去除每次手动检测）

- 目标：设置页「AI 语音 → 会议麦克风」不再要求每次手动点「一键授权并检测」；打开页面自动静默验证，ready 状态周期续期，设备变化自动重验。
- 根因：桌面壳每次启动用随机回环端口，origin 变化导致 `localStorage` 已验证线路与 `sessionStorage` readiness 快照读不到；且 5 分钟硬过期要求重点按钮。
- 采用：不新增依赖。`desktop/server-process.ts` 新增 `resolveLoopbackPort`，把端口写入 `userData/local-server-port`，空闲则复用，保持 origin 稳定；`features/audio/virtual-audio-route.ts` 存储增加 `verifiedAt`（key 升 v2，兼容读 v1），并新增 `resolveStoredRouteAgainstDevices` 按设备标签重解析 `deviceId`；`features/audio/audio-route-control.tsx` 挂载后静默跑「快照恢复 → 存储线路 tone 实测 → 已安装时完整 resolveRoute+实测」，ready 期间每 4 分钟静默续期，`devicechange` 防抖后静默重验；静默路径不触发下载/UAC，安装仍只由按钮触发。舞台页 TTS sink 先按标签重解析再 `setSinkId`。
- 可行性：Electron 已对本地 origin 自动授予 media 权限，且默认 autoplay policy 为 `no-user-gesture-required`，`AudioContext`/`audio.play()` 无需用户手势。
- 限制：未安装 VB-CABLE 的新环境不弹 UAC、保持手动按钮；静默检测失败回 idle 并提示。

# 2026-08-17：工作台全屏宽度与简历索引错误可见性

- 目标：最大化/全屏后三栏工作台随视口拉伸；「索引失败」直接展示 `indexError` 可读原因。
- 采用：现有 CSS 与 API 字段，无新依赖。`.console.workspacePage` 宽度改为 `min(1800px, 100% - 32px)`；窄屏断点调至 1280px。客户端与管理端展示已返回的 `indexError`，并对扫描件/`.doc`/embedding 不可用做中文映射。
- 未采用：第三方布局库；单独「重新索引」客户端按钮（管理端已有）。

# 2026-08-19：会议音频自动桥接（自动检测会议进程并推流到 RTC 房间）

- 目标：客户端预选一款会议软件后，检测到其进程自动捕获音频并长连接推流到 LiveKit/火山云 RTC 房间（每场会议一个房间）；散会自动停止，失败退避重试最多 3 次后转人工。
- 结论：零新增依赖，复用现有能力。
- 复用：Electron IPC `listMeetingProcesses` / AudioBridge 捕获；`/api/rtc/token` + LiveKit/火山云 transport（bridge-session 单例）；localStorage 偏好模式（同 remote-monitor.ts）。
- 未采用：`@livekit/rtc-node`（主进程推流）——火山云无对应 Node SDK，双供应商无法统一，且违反「优先复用现有能力」。
- 设计文档：docs/superpowers/specs/2026-08-19-auto-meeting-bridge-design.md

# 2026-08-19：阿里云 CosyVoice 声音刻录（自动分配音色，用户零感知）

- 目标：桌面端录音刻录助手声音时自动分配唯一音色，用户全程不需要知道任何音色 ID；阿里云线路可用时不再依赖豆包。
- 结论：零新增依赖。官方 POP OpenAPI（`nls-slp.cn-shanghai.aliyuncs.com`，Version `2019-08-19`）+ 复用项目已有 POP HMAC-SHA1 签名机制（与 CreateToken 同源，`lib/aliyun-cosyvoice.ts`）；`CosyVoiceClone` 只传 `VoicePrefix=vh`，平台自动生成 `cosyvoice-vh-xxxxxxx` 唯一音色，天然空闲无需挑选。
- 音频中转：复用已接入 control-api 的腾讯云 COS（新增 `POST/DELETE /api/v1/client/voice-samples`，存 `voice-samples/<uuid>.wav`，返回约 30 分钟预签名 GET URL，复刻后立即删除）；COS 密钥不下发客户端，桌面端无新环境变量。
- 合成：复刻音色只能走 CosyVoice 大模型，采用 NLS `FlowingSpeechSynthesizer` WebSocket 协议（JSON 指令帧 + 二进制音频帧，wav 拼接），用 Node 24 原生 WebSocket，不引入 `ws`。
- 未采用：本地 CosyVoice 开源模型（需 GPU、与桌面端定位不符）；百炼 DashScope 线路（当前控制台是智能语音交互 NLS，无百炼 API Key）；阿里云 OSS 中转（项目已有腾讯云 COS，不新增云厂商配置面）。
- 限制：复刻音色每 UID 上限 1000 个、不支持删除、1 年未用自动下线；合成需在控制台开通「语音合成 CosyVoice 大模型」商用版（冒烟脚本 `scripts/smoke-aliyun-cosyvoice.mjs` 已验证 token/POP 签名/WebSocket 连通，商用版未开通时网关返回 40000010/FREE_TRIAL_EXPIRED）。
