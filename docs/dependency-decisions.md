# 开源与依赖决策记录

每项新功能实施前，在此追加一条记录。

## 桌面工作台、设置与记录页面拆分

- 目标：让 Electron 默认页只承担数字人实时互动，把技术配置、设备检测、历史记录和纪要移到独立页面。
- 采用：复用 Next.js App Router、现有 React 组件和浏览器 `sessionStorage`，不新增路由、状态管理或 UI 依赖。
- 桌面边界：RTC 会议进程连接、实时字幕和人工介入保留在工作台；AI/RTC 凭据、OBS、数字人素材与输出检测进入设置页；安装组件卡暂不展示。
- 状态：会话存储只保存设备检测成功时间，不保存密钥、媒体流或对话数据；五分钟过期并在设备变化时级联失效。
- 兼容：服务端 API、IPC 名称、会话和归档结构保持不变，旧记录无需迁移。

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
- 双击入口：复用 `.cmd`、现有 PowerShell 和 npm 脚本，不引入 Electron、Tauri、MSI/WiX 或自动更新框架。`Start-AI-Interviewer.cmd` 日常启动，`Check-AI-Interviewer.cmd` 只读检查；`First-Time-Setup.cmd` 必须先选择最小安装（依赖+OBS，跳过 Whisper）、完整安装或退出，选择前不会执行安装下载。
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
- 安装选择：继续使用现有 electron-builder 26.15.3（MIT）与其 NSIS 能力，不引入第二套安装框架。安装改为显式 per-user one-click，并通过 electron-builder 官方 NSIS include 扩展把 `APP_FILENAME` 固定为产品名；NSIS 自动创建 `%LOCALAPPDATA%\\Programs\\AI Interviewer Desktop`，不要求用户选择或预建目录，也不为客户端本体申请管理员权限。
- 故障诊断：复用 Electron `app.setName`、`dialog` 和 Node 子进程/文件 API，固定用户数据目录产品名，并把本地服务启动输出脱敏后写入 `%APPDATA%\\AI Interviewer Desktop\\logs\\desktop-startup.log`；失败时显示路径，不增加遥测、不上传日志，API Key、Token、密码和 URL 凭据会在落盘前过滤。
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
- 首页布局：桌面宽度下改为会话设置、核心对话、会话工具三栏固定工作区，页面本身不滚动；长对话、设置表单和辅助工具仅在各自面板内部按需滚动。窗口窄于 1180px 时恢复自然文档流，避免压缩可用内容。

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
