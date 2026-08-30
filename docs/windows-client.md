# Windows 客户端使用说明

支持 Windows 10 2004 及以上、Windows 11，x64。安装包已经包含固定版本的 OBS Studio
32.2.1、AudioBridge sidecar 和签名的 Virtual-Audio-Driver / VB-CABLE 资源；不需要另外下载 OBS。
OBS 本体只在当前用户的客户端数据目录中运行，不替换或接管用户自行安装的 OBS。

## 与管理端的关系（当前主路径）

1. 先部署并登录管理控制台（`server/management-web`），用管理员配置：
   - **模型管理**：一条或多条 OpenAI 兼容 AI 线路，同步模型目录并分类；
   - **RTC 线路**：仅 LiveKit（URL / API Key / Secret）；在页面绑定互动管线
     `cascaded`（ASR+LLM+TTS）或 `e2e`；
   - **语音**：默认阿里云 NLS/CosyVoice（可试听系统音色），可选豆包线路；
   - **语音管线**：级联 / E2E 总开关与 TTS 提供方。
2. Windows 客户端用**客户端账号**登录管理端（桌面会话 `purpose: desktop`）。
3. 本机 Next 服务用桌面令牌拉取：
   - `GET /api/v1/client/settings/pipeline`（主消费路径；`e2e` 未就绪时抛
     `E2E_NOT_IMPLEMENTED`，不静默降级）；
   - `GET /api/v1/client/settings/ai` / `asr` / `speech`；
   - `POST /api/v1/client/rtc/token`（只签发 LiveKit JWT）。
4. 本机 `model.json` / `.env.local` 仅作未登录或管理端不可达时的回退，不是生产主路径。

实时会议字幕只走 **LiveKit + livekit-agent**（火山 RTC 已从产品与库表移除）。

## 首次使用

1. 安装并启动 **AI虚拟助手** 客户端。正式安装器会请求一次管理员授权，用同一套安全校验脚本注册 OBS
   Virtual Camera 的 32/64 位模块并安装虚拟音频驱动（VB-CABLE）。
2. 如果直接运行 `dist\win-unpacked` 预览版，客户端会把“OBS 已内置”和“虚拟摄像头已注册”
   分开检测。显示“需要授权”时，点击“管理员授权注册并连接”；取消 UAC 不会留下“已注册”假状态。
3. 登录管理端下发的客户端账号（不要只在本机模型页手填密钥当主路径）。
4. 打开专用 OBS“设置 → 音频 → 高级”，把监听设备选为虚拟音频播放端（`CABLE Input` /
   中文系统常见 `CABLE In 16 Ch`）。会议软件把摄像头选为 `OBS Virtual Camera`，
   麦克风选为 `CABLE Output`。
5. 客户端选择会议软件进程，启动实时字幕（LiveKit），再完成画面、测试语音和会议入会预览检查。

点击自动连接后，Electron 主进程会启动专用便携 OBS、配置助手场景和浏览器源，并启动
Virtual Camera。冷启动最多等待 30 秒。客户端只识别和停止精确位于自身专用运行目录的
`obs64.exe`；检测到用户自行启动的 OBS 时只提示关闭，不会结束或修改该进程。

## 监听和人工介入

对方声音继续由腾讯会议、飞书、钉钉或 Teams 播放，客户端不重复播放。点击“启用人工说话”会
暂停 AI、静音舞台音频并打开 Windows 默认麦克风；点击“关闭人工说话”后两路都保持静音。
点击“恢复 AI”后才继续自动流程。开启“AI 参考模式”时只显示 AI 回复，不合成或发送语音。
“立即静音全部输出”关闭两路声音。这些 OBS 操作都由 Electron 主进程通过
受限 IPC 完成，页面不能读取 WebSocket 地址、端口或密码。

## OBS 密码与本机数据

- 客户端首次运行生成长期随机 OBS WebSocket 密码，加密主副本保存在当前用户数据目录的
  `secrets\managed-obs-password.bin`；Windows 下 Electron `safeStorage` 使用当前用户 DPAPI。
- OBS 上游必须从自己的配置读取密码，因此同一密码还会以明文写入客户端专用运行目录中的
  `config\obs-studio\plugin_config\obs-websocket\config.json`。该目录属于当前 Windows 用户，
  不使用用户自行安装 OBS 的 `%APPDATA%\obs-studio` 配置。
- 密码不通过 OBS 命令行、渲染页面或 IPC 传递，客户端也不会把它写入应用日志或 OBS 启动日志。
  不要复制、上传或提交整个用户数据目录。
- 客户端只通过 `127.0.0.1:4455` 连接并强制鉴权；OBS 32.2.1 上游尚不能配置仅绑定回环地址，
  因此服务可能同时监听本机 IPv4 网卡。安装和运行不会创建 Windows 防火墙例外，长期随机密码是
  这条本机网络边界上的主要访问控制。

## 安全和限制

- 管理端密钥用 AES-256-GCM 入库；客户端只在本机 Node 内存短暂持有明文，不要提交 `data/`、
  用户数据目录或 `.env.local`。
- 原始会议 PCM 默认不落盘。会议音频经 LiveKit 到达自建 SFU / Agent；模型文本发往管理端配置的
  OpenAI 兼容端点；阿里云 ASR/TTS 按管理端语音配置出站。
- Electron 安装器目前没有企业代码签名证书，Windows 可能显示未知发布者。注册前会分别验证
  Virtual Camera 模块与 VB-CABLE 安装包的固定校验；签名、哈希或注册结果不匹配时会停止操作。
- 全局监听设备不能通过受支持的 obs-websocket 请求自动修改，首次使用必须在 OBS 设置一次。
- 发布前仍需完成真实声卡、真实会议软件和 LiveKit（含 TURN/公网 UDP）验收；当前版本面向少量内部
  试用者，不应广泛部署。

## 打包冒烟测试

`npm run test:packaged-runtime` 默认只验证打包后的本地服务，不启动 OBS，也不会触发 UAC。
已准备好干净 Windows 测试机并确保 4455 端口空闲后，可以显式开启真实 OBS 测试：

```powershell
$env:AI_INTERVIEWER_PACKAGED_OBS_SMOKE = "control"
npm run test:packaged-runtime
```

`control` 验证内置 OBS 冷启动、WebSocket 鉴权、浏览器源、场景和音频监听路由；已注册 Virtual
Camera 后可将模式改为 `real`，再验证虚拟摄像头启动。测试使用临时便携配置且不会注册组件，
结束后会停止它启动的 OBS 并删除临时目录。
