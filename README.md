# AI虚拟助手

本地 **AI虚拟助手**：可用于面试官 / 候选人辅助、会议主持、虚拟直播互动等场景。

仓库里只有一条产品路径：**Tauri** 桌面客户端。不再提供 Electron、Next.js、登录、Control API 或 Python Agent。

> 当前版本是 Windows x64 内部试用版。使用前须告知对方 AI 参与和记录方式，并由人工复核；不得用于隐蔽冒充或未经复核的自动决策。

## 环境要求

- Windows x64
- Rust 1.96
- Node.js 24
- Microsoft Edge WebView2 Runtime

## 启动

```powershell
npm install
npm run tauri:dev
```

打包：

```powershell
npm run tauri:build
```

## 验证

```powershell
npm run test:tauri
npm run test:tauri-package
```

`test:tauri` 运行 Rust 测试、Tauri UI 测试、契约测试并构建前端。`test:tauri-package` 在隔离的临时配置目录中启动已打包的可执行文件，等待最多 15 秒确认主窗口可见，并断言进程树没有 Node、Go Control API、Python、PostgreSQL 或 Nginx，安装包目录也未混入本地配置、数据库、日志或凭据测试文件。完整打包冒烟需要已经构建好的 exe；日常 CI 不跑这一步。

## 当前能力

- 本机配置 + Windows 凭据保管（Credential Manager），无登录
- SQLite 资料库与会话记录
- Direct Runtime：级联（ASR → LLM → TTS）与端到端 Realtime
- 会话命令（播报、重试、修正、纪要等）
- 可选 LiveKit 传输（同一套会话机；默认不依赖）
- C# AudioBridge 仍用于会议进程音频采集
- 无 Control API、无 Python Agent、无 Electron / Next.js

页面：工作台、资料、记录、服务、设置与诊断。

## OBS 与虚拟摄像头

Phase 6 只完成了本机 OBS / AudioBridge 路径解析和前置探测。托管 OBS、虚拟摄像头启停和快捷键界面已延期；当前客户端不会创建场景、浏览器源或启动 Virtual Camera。不要用 Electron 去补完 OBS。

可把官方便携 OBS 放到 `resources/prerequisites` 供探测使用；当前 Tauri 安装包不会管理或随包启动 OBS。

## 当前限制

- 仅 Windows x64 内部试用，须告知对方并由人工复核。
- 托管 OBS / 虚拟摄像头 / 热键 UI 尚未接入。
- 设置页部分出镜与诊断能力仍是壳层占位。
