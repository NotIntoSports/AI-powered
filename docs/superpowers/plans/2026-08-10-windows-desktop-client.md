# Windows Desktop Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有 AI 面试控制台交付为 Windows 10/11 x64 一体化客户端，并建立可公开的 GitHub 开源仓库。

**Architecture:** Electron 主进程以单实例方式启动独立的 Next.js standalone 子进程，在安全 BrowserWindow 中加载回环地址，并管理自己启动的 OBS。前置组件安装器使用固定清单、SHA-256、Authenticode 验证和可恢复状态机；OBS 与虚拟音频驱动仍作为独立开源组件安装，客户端不自行实现驱动。

**Tech Stack:** Electron 43.3.0、Electron Forge 7.11.2、Next.js 15、React 19、TypeScript、Node test runner、OBS Studio 32.1.2、Windows PowerShell/DPAPI、GitHub CLI。

## Global Constraints

- 目标平台固定为 Windows 10/11 x64，首版只支持单候选人。
- AI 与语音识别只使用用户配置的在线 HTTPS API，不打包本地模型。
- 不自行开发摄像头或音频驱动；优先复用现有代码、官方能力和成熟开源依赖。
- 不采用需要购买商业分发授权或输入激活码的组件，但必须保留全部开源许可证声明。
- API Key 不得进入渲染进程源码、日志、安装包或 Git 仓库，持久化时使用 Windows DPAPI。
- 原始候选人音频默认不保存，在线服务的数据去向必须在界面明确展示。
- 所有第三方二进制必须固定版本并通过 SHA-256 与 Authenticode 检查。
- 不得自动启用 Windows 测试签名模式；音频驱动签名不合格时阻止发布。
- 每项功能先更新 `docs/dependency-decisions.md`，再做最小集成、测试、构建和冒烟验证。

---

## File Structure

- `desktop/main.ts`：Electron 生命周期、单实例和安全窗口。
- `desktop/preload.ts`：最小白名单 IPC。
- `desktop/server-process.ts`：选择端口并管理 Next standalone 子进程。
- `desktop/obs-process.ts`：探测及管理客户端拥有的 OBS 进程。
- `desktop/prerequisites/manifest.ts`：第三方组件固定清单。
- `desktop/prerequisites/verify.ts`：SHA-256 与 Authenticode 验证。
- `desktop/prerequisites/state-machine.ts`：可恢复安装状态机。
- `desktop/prerequisites/windows-install.ts`：提权安装与重启恢复适配层。
- `desktop/ipc.ts`：类型化 IPC 注册。
- `desktop/types.ts`：桌面端共享类型。
- `scripts/build-next-standalone.mjs`：整理 Next standalone 资源。
- `scripts/fetch-prerequisites.ps1`：从官方发布页下载固定组件并校验。
- `scripts/verify-release.ps1`：发布包、许可证和敏感信息检查。
- `tests/desktop/*.test.mjs`：桌面主进程和前置组件测试。
- `forge.config.ts`：Electron Forge Windows 打包配置。
- `resources/licenses/`：第三方许可证和声明。
- `resources/prerequisites/`：构建时下载、Git 忽略的固定二进制。
- `app/api/desktop/status/route.ts`：只读桌面运行状态。
- `features/desktop/client-readiness.tsx`：客户端开播检查卡。
- `docs/windows-client.md`：用户安装、首次启动和恢复说明。

### Task 1: 依赖决策与开源基线

**Files:**
- Modify: `docs/dependency-decisions.md`
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `LICENSE`
- Create: `THIRD_PARTY_NOTICES.md`

**Interfaces:**
- Consumes: 已确认设计及官方依赖资料。
- Produces: 固定依赖版本、公开仓库许可证和二进制重分发门槛。

- [ ] **Step 1: 记录依赖结论**

在 `docs/dependency-decisions.md` 增加 Electron 43.3.0（MIT）、Electron Forge 7.11.2（MIT）、OBS Studio 32.1.2（GPL-2.0-or-later）和 VirtualDrivers/Virtual-Audio-Driver 25.7.14（MIT/MS-PL 部分）的版本、维护状态、体积、Windows 兼容性、数据流、集成成本及签名发布阻断条件。

- [ ] **Step 2: 安装桌面构建依赖**

Run: `npm install --save-dev --save-exact electron@43.3.0 @electron-forge/cli@7.11.2 @electron-forge/maker-squirrel@7.11.2 @electron-forge/plugin-vite@7.11.2 vite typescript`
Expected: `package-lock.json` 固定全部版本且 `npm audit` 不出现 high/critical。

- [ ] **Step 3: 建立公开许可证文件**

创建 MIT 项目许可证，并在 `THIRD_PARTY_NOTICES.md` 列出 OBS、Electron、Forge、Next.js、React、obs-websocket-js、VAD Web 和虚拟音频驱动的许可证及源码链接；明确随包 OBS 继续受 GPL 条款约束。

- [ ] **Step 4: 排除本地产物和敏感数据**

向 `.gitignore` 增加 `out/`、`dist/`、`resources/prerequisites/*.exe`、`resources/prerequisites/*.zip`、`*.log`、`.env*`，并保留 `!.env.example`。

- [ ] **Step 5: 验证依赖与提交**

Run: `npm audit --audit-level=high`
Expected: exit 0。

Run: `git add package.json package-lock.json .gitignore LICENSE THIRD_PARTY_NOTICES.md docs/dependency-decisions.md && git commit -m "chore: establish desktop open source dependencies"`

### Task 2: Next.js Standalone 运行产物

**Files:**
- Modify: `next.config.mjs`
- Modify: `package.json`
- Create: `scripts/build-next-standalone.mjs`
- Create: `tests/desktop/standalone-assets.test.mjs`

**Interfaces:**
- Consumes: Next.js 15 build output。
- Produces: `npm run build:standalone` 和 `.desktop-runtime/server.js`。

- [ ] **Step 1: 写失败测试**

测试断言 `next.config.mjs` 含 `output: "standalone"`，并断言构建整理脚本复制 `.next/static` 与 `public` 到 `.desktop-runtime`。

- [ ] **Step 2: 运行失败测试**

Run: `node --test tests/desktop/standalone-assets.test.mjs`
Expected: FAIL，提示 standalone 配置或脚本缺失。

- [ ] **Step 3: 实现最小 standalone 整理**

在 Next 配置启用 `output: "standalone"`；整理脚本使用 `fs.cp` 将 `.next/standalone`、`.next/static` 和 `public` 复制到 `.desktop-runtime`，任何源目录缺失都以非零退出。

- [ ] **Step 4: 验证构建与启动**

Run: `npm run build && npm run build:standalone && node --test tests/desktop/standalone-assets.test.mjs`
Expected: PASS，且 `.desktop-runtime/server.js` 存在。

- [ ] **Step 5: 提交**

Run: `git add next.config.mjs package.json scripts/build-next-standalone.mjs tests/desktop/standalone-assets.test.mjs && git commit -m "build: produce desktop standalone runtime"`

### Task 3: 安全 Electron 桌面壳

**Files:**
- Create: `desktop/types.ts`
- Create: `desktop/server-process.ts`
- Create: `desktop/preload.ts`
- Create: `desktop/ipc.ts`
- Create: `desktop/main.ts`
- Create: `tests/desktop/server-process.test.mjs`
- Create: `tests/desktop/window-security.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `startLocalServer(options): Promise<OwnedProcess>`、`stopOwnedProcess(process): Promise<void>`、`createMainWindow(baseUrl): BrowserWindow`、`DesktopBridge.getStatus(): Promise<DesktopStatus>`。

- [ ] **Step 1: 写端口与进程所有权失败测试**

测试随机回环端口、健康检查超时、只终止带 `owned: true` 的子进程，以及 `ELECTRON_RUN_AS_NODE=1` 环境变量传递。

- [ ] **Step 2: 写窗口安全失败测试**

测试源码配置包含 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`，并拒绝非 `127.0.0.1`/`localhost` 导航、窗口打开和非白名单 IPC。

- [ ] **Step 3: 运行测试确认失败**

Run: `node --test tests/desktop/server-process.test.mjs tests/desktop/window-security.test.mjs`
Expected: FAIL，提示模块缺失。

- [ ] **Step 4: 实现主进程最小闭环**

实现单实例锁、随机端口、Next 子进程启动、`/api/health` 就绪轮询、安全窗口、最小 preload、窗口关闭时清理自有进程；开发模式允许显式 `AI_INTERVIEWER_DEV_URL`。

- [ ] **Step 5: 验证桌面壳**

Run: `node --test tests/desktop/server-process.test.mjs tests/desktop/window-security.test.mjs && npm run build`
Expected: PASS。

- [ ] **Step 6: 提交**

Run: `git add desktop tests/desktop package.json package-lock.json && git commit -m "feat: add secure Electron desktop shell"`

### Task 4: OBS 进程管理与动态舞台地址

**Files:**
- Create: `desktop/obs-process.ts`
- Create: `tests/desktop/obs-process.test.mjs`
- Modify: `features/obs/obs-service.ts`
- Modify: `app/api/obs/runtime/route.ts`
- Modify: `features/obs/obs-control.tsx`

**Interfaces:**
- Consumes: Electron 运行时 `baseUrl`。
- Produces: `detectObs(): ObsInstallation | null`、`startOwnedObs(installation): OwnedProcess`、运行时 `stageUrl`。

- [ ] **Step 1: 写失败测试**

覆盖注册表和常见路径探测、已有 OBS 不归客户端所有、启动参数、动态 `stageUrl` 写入浏览器源。

- [ ] **Step 2: 运行失败测试**

Run: `node --test tests/desktop/obs-process.test.mjs scripts/test-obs-service.mjs`
Expected: 新测试 FAIL。

- [ ] **Step 3: 实现 OBS 适配**

主进程只启动缺失的 OBS；Next 服务从可信运行配置读取 base URL，不再假设端口 3000；退出只停止当前客户端拥有的实例。

- [ ] **Step 4: 验证**

Run: `node --test tests/desktop/obs-process.test.mjs && npm run test:obs && npm run build`
Expected: PASS。

- [ ] **Step 5: 提交**

Run: `git add desktop/obs-process.ts tests/desktop/obs-process.test.mjs features/obs app/api/obs/runtime/route.ts && git commit -m "feat: manage OBS from desktop runtime"`

### Task 5: 前置组件验证与可恢复安装

**Files:**
- Create: `desktop/prerequisites/manifest.ts`
- Create: `desktop/prerequisites/verify.ts`
- Create: `desktop/prerequisites/state-machine.ts`
- Create: `desktop/prerequisites/windows-install.ts`
- Create: `tests/desktop/prerequisite-verify.test.mjs`
- Create: `tests/desktop/prerequisite-state.test.mjs`
- Create: `scripts/fetch-prerequisites.ps1`
- Create: `resources/prerequisites/.gitkeep`

**Interfaces:**
- Produces: `verifyArtifact(path, expected): Promise<VerificationResult>`、`advanceInstallState(state, probe): InstallState`、`installPrerequisite(id): Promise<InstallResult>`。

- [ ] **Step 1: 写校验失败测试**

使用临时文件覆盖 SHA-256 匹配/不匹配、非 Windows 签名结果、发布者不匹配和未知组件拒绝执行。

- [ ] **Step 2: 写状态机失败测试**

覆盖 `not-started -> installing -> reboot-required -> verifying -> complete`、失败重试、已完成步骤幂等和拒绝跳步。

- [ ] **Step 3: 运行确认失败**

Run: `node --test tests/desktop/prerequisite-verify.test.mjs tests/desktop/prerequisite-state.test.mjs`
Expected: FAIL，提示模块缺失。

- [ ] **Step 4: 实现固定清单和验证**

OBS 清单固定 32.1.2 x64 官方 URL、官方 SHA-256 和允许的签名发布者；音频驱动固定 25.7.14，但只有实机下载后 Authenticode 为 Valid 且发布者符合清单才允许进入安装包，否则返回 `release-blocked`。

- [ ] **Step 5: 实现安装状态机**

状态保存到 `%APPDATA%\AI Interviewer\install-state.json`，使用临时文件加原子替换；提权只发生在用户确认后的具体安装步骤，不修改测试签名设置。

- [ ] **Step 6: 验证**

Run: `node --test tests/desktop/prerequisite-verify.test.mjs tests/desktop/prerequisite-state.test.mjs`
Expected: PASS。

- [ ] **Step 7: 提交**

Run: `git add desktop/prerequisites tests/desktop scripts/fetch-prerequisites.ps1 resources/prerequisites/.gitkeep && git commit -m "feat: add verified prerequisite installer state machine"`

### Task 6: 客户端就绪检查与人工控制

**Files:**
- Create: `app/api/desktop/status/route.ts`
- Create: `features/desktop/client-readiness.tsx`
- Create: `tests/desktop/client-readiness.test.mjs`
- Modify: `app/page.tsx`
- Modify: `features/readiness/interview-readiness.ts`
- Modify: `app/styles.css`

**Interfaces:**
- Consumes: `DesktopStatus`、现有模型/转写/OBS/摄像头/音频/会议交接状态。
- Produces: 开播检查卡和严格的 `canStartInterview` 判定。

- [ ] **Step 1: 写失败测试**

断言 API 缺失、摄像头无预览、音频无信号或会议软件未确认时均返回不可开始；全部通过才允许开始，并始终暴露暂停 AI、人工接管和紧急停止动作。

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/desktop/client-readiness.test.mjs && npm run test:readiness`
Expected: 新测试 FAIL。

- [ ] **Step 3: 实现检查卡**

复用现有就绪逻辑并增加桌面状态；紧急停止顺序固定为停止 TTS、停止自动提问、停止虚拟摄像头输出、将会话标记为人工接管。

- [ ] **Step 4: 验证**

Run: `node --test tests/desktop/client-readiness.test.mjs && npm run test:readiness && npm run test:meeting-handoff && npm run build`
Expected: PASS。

- [ ] **Step 5: 提交**

Run: `git add app features/desktop features/readiness tests/desktop/client-readiness.test.mjs && git commit -m "feat: add desktop interview readiness controls"`

### Task 7: Forge 打包、许可证与发布验证

**Files:**
- Create: `forge.config.ts`
- Create: `scripts/verify-release.ps1`
- Create: `docs/windows-client.md`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: standalone runtime、前置组件清单、许可证材料。
- Produces: `npm run make:windows` 和可审计的 Windows x64 安装产物。

- [ ] **Step 1: 写发布验证脚本**

脚本检查安装产物存在、架构为 x64、standalone 静态资源完整、第三方许可证齐全、二进制哈希匹配，并用高置信规则扫描 `.env`、API Key、令牌和 `data/` 候选人记录。

- [ ] **Step 2: 配置 Forge**

配置 Squirrel Windows x64 maker、应用图标、asar、额外资源和 `packagerConfig.executableName`；只包含运行所需文件，不打包源数据、测试、`.env` 或本地日志。

- [ ] **Step 3: 补充使用文档**

记录首次安装、管理员授权、重启续装、API 配置、会议软件设备选择、人工接管、紧急停止、卸载和已知限制。

- [ ] **Step 4: 构建并验证安装包**

Run: `npm run make:windows`
Expected: 生成 Windows x64 安装器；若音频驱动签名门槛未通过，则命令以 `release-blocked` 退出且不生成可分发包。

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/verify-release.ps1`
Expected: PASS。

- [ ] **Step 5: 提交**

Run: `git add forge.config.ts scripts/verify-release.ps1 docs/windows-client.md README.md package.json package-lock.json && git commit -m "build: package Windows desktop client"`

### Task 8: 全量回归与 GitHub 开源发布

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `SECURITY.md`
- Create: `CONTRIBUTING.md`
- Create: `docs/release-checklist.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: 所有代码、测试和发布验证。
- Produces: 公开 GitHub 仓库与可重复 CI。

- [ ] **Step 1: 创建 CI 和社区文件**

CI 在 Windows runner 使用固定 Node LTS，执行 `npm ci`、全部 `test:*`、`npm run build`、桌面测试和无二进制的 Forge package smoke；`SECURITY.md` 禁止公开提交候选人数据或密钥。

- [ ] **Step 2: 执行完整本地回归**

Run: `npm test`（先增加聚合脚本，包含现有 24 项和桌面测试）
Expected: 全部 PASS。

Run: `npm run build && npm run package:smoke && npm audit --audit-level=high`
Expected: 全部 exit 0。

- [ ] **Step 3: 初始化 Git 仓库并做敏感信息预检**

Run: `git init -b main && git add --dry-run .`
Expected: 不包含 `data/`、`.env.local`、`.tools/`、`node_modules/`、`.next/`、前置二进制或日志。

Run: `git add . && git commit -m "feat: release AI interviewer desktop client"`

- [ ] **Step 4: 安装并认证 GitHub CLI**

若 `gh` 不存在，使用 `winget install --id GitHub.cli --exact --source winget`；随后运行 `gh auth status`。若未认证，执行 `gh auth login --web --git-protocol https`，由用户在 GitHub 浏览器页面完成授权。

- [ ] **Step 5: 创建公开仓库**

Run: `gh repo create ai-interviewer-desktop --public --source . --remote origin --push --description "Open-source Windows AI interviewer with OBS virtual camera support"`
Expected: GitHub 返回公开仓库 URL，`git branch -vv` 显示 `main` 跟踪 `origin/main`。

- [ ] **Step 6: 检查远端公开内容**

Run: `gh repo view --web` 和 `gh api repos/{owner}/ai-interviewer-desktop/contents`
Expected: 仓库公开、README/许可证/安全说明存在，且没有本地数据、密钥和安装器二进制。

- [ ] **Step 7: Windows 人工验收**

按 `docs/release-checklist.md` 在干净 Windows 10/11 x64 环境测试安装、重启续装、升级、卸载，并在至少两种会议软件验证摄像头、虚拟麦克风、在线转写、AI 追问、人工接管和紧急停止。只有全部签字通过才创建 GitHub Release。

- [ ] **Step 8: 最终提交与推送**

Run: `git add .github SECURITY.md CONTRIBUTING.md docs/release-checklist.md README.md && git commit -m "ci: add public release safeguards" && git push`
Expected: CI 通过；若实机驱动验收尚未完成，只发布源码仓库，不上传可执行安装包。
