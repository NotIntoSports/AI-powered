# 管理端与 Windows 客户端拆分设计

日期：2026-08-14
状态：已确认，待实施计划

## 1. 目标

将当前单机应用拆分为可部署在服务器上的管理端和继续运行在 Windows 上的客户端：

- 管理端集中提供管理员登录、用户管理、AI/RTC 配置、密钥保管、远程 AI 调用、RTC Token 签发、客户端配置下发和审计；
- Windows 客户端继续负责 OBS、虚拟摄像头、音频桥接、Windows SAPI、会议进程、设备检测、数字人舞台、本地转写和可选本地模型；
- 首版不预创建普通客户端用户，只有管理员账号。管理员以后通过管理后台手工创建客户端用户；
- 首版不上传头像、视频、原始录音、完整转写、面试记录或报告，候选人数据默认保留在客户端；
- 客户端不再保存远程 AI API Key 或 RTC Secret。

## 2. 非目标

首版不包含：

- 公开注册、邀请注册、短信或邮件注册；
- 社交登录、OIDC、SAML、MFA 或密码找回邮件；
- 多租户、组织和复杂 RBAC；
- 服务端保存候选人媒体和面试记录；
- 用 Rust/Tauri 重写现有 Electron 客户端；
- 服务端远程控制本机摄像头、麦克风、OBS 或会议软件；
- 自研虚拟摄像头或虚拟音频驱动。

## 3. 选型结论

### 3.1 推荐方案

采用分阶段混合架构：

- 管理后台前端：Next.js；
- 管理 API：Go；
- 数据库：PostgreSQL；
- Windows 客户端：保留 Electron + Next.js；
- 通信：HTTPS JSON API；
- 客户端在线状态：定时心跳，不引入常驻 WebSocket；
- 认证：服务端可撤销的随机会话令牌，不使用长期 JWT；
- 密码：Argon2id；
- 数据库迁移：goose；
- PostgreSQL 驱动：pgx/v5；
- HTTP 路由：chi。

心跳足以覆盖首版的配置刷新、在线状态和强制退出。只有后续出现秒级任务推送或远程指令需求时才增加 WebSocket。

### 3.2 备选方案

1. 保留全部 Next.js Route Handler，仅远程部署：开发量较小，但会继续混合服务器和 Windows 专属能力，也难以安全隔离本地设备接口，因此不采用。
2. 全部能力云端化：统一性高，但会扩大候选人数据、音频、延迟、带宽和合规范围，因此首版不采用。
3. 引入 Ory Kratos：身份能力成熟，但当前只有管理员创建用户、登录、禁用和强制下线，完整身份平台明显过重，因此暂不采用。

## 4. 总体架构

```text
管理后台浏览器 ───────┐
                      ├── HTTPS ── Go 管理 API ── PostgreSQL
Windows Electron 客户端 ┘                   ├── 远程 AI
                                            └── RTC Token 签发

Windows Electron 客户端
  ├── Next.js 本地 UI 与舞台
  ├── Electron 主进程与受限 IPC
  ├── OBS / Virtual Camera
  ├── AudioBridge / SAPI / 会议进程
  ├── whisper.cpp / Ollama（可选本地模式）
  └── 本机 SQLite、头像和媒体文件
```

管理 API 只处理网络服务和共享状态；任何必须访问 Windows 设备、进程、DPAPI 或回环服务的能力留在客户端。

## 5. 组件边界

### 5.1 管理端职责

- 初始化唯一管理员；
- 管理员登录、退出和会话管理；
- 创建、编辑、禁用和删除普通用户；
- 重置用户密码、撤销用户全部会话；
- 保存 AI Base URL、模型名、超时、启用状态和加密后的 API Key；
- 测试 AI 配置，但不记录测试密钥或完整上游错误响应；
- 保存 RTC App ID、语言、模式和加密后的 Secret；
- 按已登录用户、设备、房间和有效期签发 RTC Token；
- 生成 AI 追问和面试报告；
- 下发客户端可见配置和功能策略；
- 接收客户端心跳并记录版本、设备 ID 和最后在线时间；
- 记录登录、退出、用户变更、配置变更、密钥轮换和会话撤销审计。

### 5.2 客户端职责

- 提供登录页面，不提供注册入口；
- 使用 Electron `safeStorage` 保存客户端会话令牌；
- 拉取当前用户允许使用的非敏感配置；
- 定期发送心跳并处理账号禁用、会话撤销和版本策略；
- 通过管理 API 获取远程 AI 结果和短期 RTC Token；
- 保留本地 Ollama 和 whisper.cpp 模式；
- 继续管理 OBS、摄像头、麦克风、虚拟声卡、SAPI、AudioBridge 和会议进程；
- 继续在本地 SQLite 保存当前会话和历史记录；
- 继续在本地文件系统保存头像、视频和其他媒体。

### 5.3 共享协议

管理端和客户端共享稳定的 JSON DTO 和错误码，不共享 Go 或 Electron 内部实现。协议至少包含：

- 登录用户摘要；
- 客户端配置快照及版本号；
- 设备心跳；
- RTC Token 请求和响应；
- AI 追问请求和响应；
- AI 报告请求和响应；
- 标准错误结构 `{ code, message, requestId }`。

## 6. 认证与授权

### 6.1 角色

- `admin`：访问管理后台和全部管理 API；
- `operator`：登录 Windows 客户端，只能获取自己的配置并调用客户端 API。

首版仅初始化 `admin`，不自动创建任何 `operator`。

### 6.2 管理员初始化

提供一次性服务器命令，例如：

```text
control-api admin create --username <name>
```

密码通过交互式标准输入读取，或由仅在首次初始化时存在的受保护文件输入。命令拒绝在管理员已存在时重复创建，除非使用明确的恢复流程。项目不提供默认管理员用户名和密码。

### 6.3 密码

- 使用 Argon2id 和每个密码独立的安全随机 salt；
- 存储算法版本、参数、salt 和摘要；
- 参数从配置读取并设安全下限，登录成功时可渐进升级；
- 密码不加密、不写日志、不通过命令行参数传递；
- 管理员重置密码后撤销该用户全部会话。

### 6.4 会话

- 登录成功生成至少 256 位的密码学随机令牌；
- 客户端只拿到令牌明文一次；
- 数据库存储 SHA-256 令牌摘要、用户、设备、创建时间、最后使用时间和过期时间；
- 管理后台通过 `HttpOnly; Secure; SameSite=Strict` Cookie 传递；
- Electron 通过 `Authorization: Bearer` 传递，并使用 `safeStorage` 持久化；
- 不把会话令牌放入 URL、日志、localStorage 或 sessionStorage；
- 登出、禁用、删除、密码重置和强制下线均服务端撤销会话；
- 管理后台和客户端使用不同的会话用途字段，防止跨用途复用；
- 所有认证响应使用 `Cache-Control: no-store`。

### 6.5 防护

- 全站 HTTPS；
- 登录按账号和来源 IP 限流；
- 失败响应不区分用户名不存在或密码错误；
- 管理 API 校验 `admin` 角色；
- Cookie 管理接口校验 Origin，并使用严格 SameSite；
- Bearer API 只接受请求头令牌；
- 安全事件和配置变更写审计日志，但清除敏感字段。

## 7. 配置与密钥

### 7.1 AI

管理端保存：

- provider 名称；
- Base URL；
- 模型名；
- 追问和报告超时；
- 启用状态；
- 加密 API Key；
- 配置版本和最后修改人。

客户端只能看到 provider、模型展示名、模式、配置版本和可用状态。远程模型请求由 Go 发起，API Key 永不下发。

### 7.2 RTC

管理端保存 App ID、语言、生产模式配置和加密 Secret。客户端提交房间与用户请求后，管理端校验登录用户和格式，生成短期 Token，只返回 App ID、Token、房间、RTC 用户 ID 和过期时间。

### 7.3 服务端加密

- 生产环境优先使用云 Secret Manager、Vault 或容器编排器 Secret；
- 若数据库必须保存密文，使用服务器主密钥进行带认证加密；
- 主密钥不进入数据库、镜像、Git、前端、日志或 API；
- 密文保存密钥版本以支持轮换；
- AI/RTC 配置读取接口永不返回现有 Secret。

### 7.4 本地模式

客户端可保留 `local` 模式：

- 只允许 `localhost`、`127.0.0.1`、`::1`；
- 本地 Ollama/whisper.cpp 地址和可选本地凭据保留在 Windows 客户端；
- 管理端下发是否允许本地模式，客户端不能自行绕过策略；
- 本地模式不把候选人内容发送到管理服务器的 AI 接口。

## 8. 数据模型

### 8.1 首版表

- `users`：ID、用户名、密码摘要、角色、状态、创建/更新时间、最后登录时间；
- `user_sessions`：令牌摘要、用户、用途、设备、创建/过期/撤销时间；
- `devices`：稳定设备 ID、所属用户、客户端版本、操作系统、最后在线和禁用状态；
- `system_settings`：非敏感全局策略和配置版本；
- `ai_provider_configs`：AI 非敏感配置、加密 Key、密钥版本；
- `rtc_configs`：RTC 非敏感配置、加密 Secret、密钥版本；
- `audit_logs`：操作者、动作、目标、结果、请求 ID、来源 IP、时间和脱敏元数据；
- `client_heartbeats`：可按规模选择只更新 `devices` 或保存短期历史。

所有主键使用服务器生成的不可预测 ID。用户名使用规范化后的唯一索引；删除用户默认采用停用/软删除，防止审计关系丢失。

### 8.2 后续表

只有确认候选人数据允许上云后才增加：

- `interview_sessions`；
- `interview_transcripts`；
- `interview_reports`；
- `media_objects`。

该阶段需要单独设计数据同意、保存期限、删除、导出、对象存储、访问审计和备份恢复。

## 9. API 设计

### 9.1 认证

```text
POST /api/v1/auth/login
POST /api/v1/auth/logout
GET  /api/v1/auth/me
```

### 9.2 管理员

```text
GET   /api/v1/admin/users
POST  /api/v1/admin/users
PATCH /api/v1/admin/users/{id}
POST  /api/v1/admin/users/{id}/reset-password
POST  /api/v1/admin/users/{id}/revoke-sessions

GET  /api/v1/admin/settings/ai
PUT  /api/v1/admin/settings/ai
POST /api/v1/admin/settings/ai/test

GET  /api/v1/admin/settings/rtc
PUT  /api/v1/admin/settings/rtc
POST /api/v1/admin/settings/rtc/test

GET /api/v1/admin/devices
GET /api/v1/admin/audit-logs
```

### 9.3 客户端

```text
GET  /api/v1/client/config
POST /api/v1/client/heartbeat
POST /api/v1/rtc/token
POST /api/v1/ai/question
POST /api/v1/ai/report
```

所有写接口执行输入大小限制、结构校验、请求超时和稳定错误码。AI 请求复用当前提示词注入防护、敏感问题过滤、重复问题检测、模型输出清洗和报告引文核验逻辑。

## 10. 当前代码迁移边界

### 10.1 迁到 Go

- `lib/runtime-config.ts` 的远程 AI 配置；
- `lib/llm.ts` 的远程 AI 请求；
- `lib/model-probe.ts` 的远程模型测试；
- `lib/rtc-settings.ts` 的生产 RTC 配置和 Token 签发；
- `app/api/settings/model/**`；
- `app/api/settings/rtc/**`；
- `app/api/rtc/token`；
- `app/api/session` 中远程 AI 追问和报告部分。

### 10.2 留在客户端

- `desktop/**`；
- `native/AudioBridge/**`；
- `lib/windows-tts.ts`；
- `lib/stage-status.ts`；
- OBS、设备、会议软件和虚拟摄像头相关 API；
- 头像上传和媒体读取；
- 本机 SQLite 会话和历史记录；
- 本地 whisper.cpp 和 Ollama 适配。

### 10.3 需要拆分

当前 `app/api/session` 继续负责本地会话状态和原子轮次写入，但生成追问/报告时调用 Go API。只有 Go 成功返回经过校验的结果后，客户端才提交本地 SQLite 事务；远程失败不得留下半轮数据。

## 11. 错误和降级

- 管理服务器不可达：远程 AI 和 RTC 显示明确不可用；允许本地模式时可继续本地 AI/转写；
- 登录过期或撤销：清除客户端令牌并返回登录页，不继续重试受保护请求；
- AI 超时：返回稳定 504 错误，客户端保留候选人输入并允许重试；
- RTC Token 失败：不进入 RTC 房间，保留人工输入路径；
- 配置版本变化：客户端在下次心跳或显式刷新时拉取新配置；
- 数据库不可用：管理 API 返回 503，不绕过认证或使用过期配置；
- 密钥无法解密：配置标记不可用并记录脱敏审计，不返回密文或上游 Secret；
- 强制退出：下一次 API 请求或心跳立即收到会话撤销状态。

## 12. 部署

推荐容器化部署：

- `admin-web`；
- `control-api`；
- `postgres`；
- Caddy 或 Nginx 负责 TLS、请求体大小和基础安全头。

只对公网开放 443。PostgreSQL 和 Go 内部端口不直接暴露。生产环境使用独立数据库用户、最小权限、加密备份、日志轮转和健康检查。管理 API 可编译为单一 Go 二进制，容器以非 root 用户运行。

Windows 客户端新增服务器地址配置，但生产包应固定允许的 HTTPS Origin 或使用签名配置，避免普通用户把客户端指向恶意服务器。开发构建可通过明确的开发开关连接本机测试服务。

## 13. 开源依赖决策

- Go 标准库：HTTP、TLS、JSON、密码学随机数和 SHA-256；
- `github.com/go-chi/chi/v5`：MIT，轻量 HTTP 路由；
- `github.com/jackc/pgx/v5`：MIT，活跃维护的 PostgreSQL 驱动；
- `golang.org/x/crypto/argon2`：BSD-3-Clause，Argon2id 实现；
- `github.com/pressly/goose/v3`：MIT，支持嵌入式 SQL 数据库迁移；
- Ory Kratos：Apache-2.0、活跃维护，但对首版需求过重，不采用；
- 不新增 AI SDK，继续使用 OpenAI-compatible HTTP，降低供应商绑定和依赖体积。

实施时必须在 `docs/dependency-decisions.md` 追加版本、许可证、维护状态、安全公告、安装体积、运行成本和兼容性记录，并在锁定版本后运行依赖漏洞扫描。

## 14. 实施阶段

### 阶段 A：管理服务基础

建立 Go 模块、配置加载、PostgreSQL、goose 迁移、健康检查、请求 ID、结构化脱敏日志和测试框架。

### 阶段 B：认证和管理后台

实现管理员初始化、登录、退出、用户管理、禁用、密码重置、会话撤销和审计。管理后台加入登录页、用户页和受保护布局。此阶段不创建普通用户数据。

### 阶段 C：AI 集中化

迁移远程 AI 配置、模型探测、追问和报告。客户端新增管理 API 适配层，同时保留本地模型适配层。迁移完成并验证服务器配置后，删除客户端磁盘中的旧远程 AI Key。

### 阶段 D：RTC 集中化

迁移 RTC Secret、生产 Token 签发和配置测试。客户端只保留 App ID 展示信息和短期 Token。迁移完成后删除本地试用/生产长期凭据。

### 阶段 E：客户端登录和设备

新增登录窗口、`safeStorage` 会话、配置拉取、设备 ID、心跳、禁用和强制下线。服务器不预创建普通用户，管理员可在后台手工创建后再测试客户端登录。

### 阶段 F：加固与交付

执行构建、类型检查、Go 单元/集成测试、PostgreSQL 迁移测试、认证安全测试、Windows 冒烟测试和打包测试；更新安装、部署、密钥轮换、备份和故障恢复文档。

## 15. 测试与验收

必须覆盖：

- 无管理员、重复初始化和安全密码输入；
- 正确/错误登录、限流、过期、登出和会话撤销；
- 非管理员访问管理 API；
- 用户禁用、密码重置和强制退出；
- API Key/RTC Secret 不出现在响应、日志和客户端磁盘；
- AI 配置测试、超时、错误清洗和结果校验；
- RTC Token 用户、房间、有效期和签发失败；
- 配置版本更新和客户端刷新；
- 管理端不可达、本地模式允许/禁止和恢复；
- 本地会话轮次在远程 AI 失败时不产生部分提交；
- OBS、虚拟摄像头、音频、SAPI、RTC 字幕和本地历史记录回归；
- 数据库迁移前进、重复执行、空库初始化和备份恢复；
- Next.js 构建、TypeScript 检查、Go 测试和 Windows 安装包冒烟测试。

验收完成时，Windows 客户端及其数据目录不得包含远程 AI API Key 或 RTC Secret；管理员应能在不重新发布客户端的情况下修改 AI/RTC 配置，并能禁用用户使其现有会话失效。

## 16. 后续扩展边界

以下能力必须另行设计后再实施：

- 候选人记录、报告或媒体上传；
- 多管理员和细粒度权限；
- 多租户；
- MFA、OIDC 或企业 SSO；
- 自动更新和版本强制升级；
- 秒级远程任务推送；
- 服务端统计、配额和计费。

这些扩展不能通过复用现有审计或心跳表直接拼接，必须明确新的数据、权限、保留和失败边界。
