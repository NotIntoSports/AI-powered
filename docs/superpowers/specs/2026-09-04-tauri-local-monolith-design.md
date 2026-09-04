# Tauri 本地单体客户端架构设计

**日期：** 2026-09-04

**状态：** 已确认，等待实施计划

**目标平台：** Windows 10 22H2 / Windows 11 x64

**目标产品：** 单机、单用户、开源 AI 虚拟助手桌面客户端

## 1. 摘要

项目将从“Electron 客户端 + Next.js 本地服务 + 独立管理网页 + Go Control API + PostgreSQL/pgvector + Python LiveKit Agent”的多端架构，迁移为一个以本地配置和本地数据为中心的桌面应用：

- Tauri 2 提供桌面壳、安全 IPC 和 Windows 集成；
- React + TypeScript + Vite 只负责界面；
- Rust 负责配置、密钥、SQLite、资料、向量检索、会话、AI Runtime、第三方服务、OBS 和进程管理；
- SQLite + sqlite-vec 保存会话、资料原文、切片、向量和索引状态；
- Windows Credential Manager 持久保存 API Key、Token 和 Secret；
- C# AudioBridge 在第一阶段作为受控 sidecar 保留；
- Python Agent 仅在迁移期作为 sidecar，能力迁完后删除；
- 管理网页、登录、多用户、Go Control API、PostgreSQL、Nginx 和项目作者服务器依赖全部退役。

客户端可以连接用户自己的本地服务或第三方云服务，但不需要修改或管理任何自建服务器配置。默认运行链路不依赖 LiveKit；LiveKit 是可选传输适配器。

## 2. 背景与问题

当前项目同时维护桌面客户端与服务器管理端。同一项配置、状态和错误在多个语言、进程、页面和数据源中重复表达，造成：

- 开源用户需要理解和部署多个组件；
- AI 或贡献者难以判断功能应修改客户端还是管理端；
- 配置可能来自环境变量、远程数据库、客户端缓存或管理页面；
- 排障前必须先确认故障所在端；
- 登录、账户、在线状态和管理审计对单机开源产品没有足够价值；
- 资料与语音运行链路对自建服务器形成隐性依赖。

本设计优先减少认知负担、部署面和故障面。安装包体积和内存是重要目标，但不能以牺牲功能完整性或制造一次性大爆炸重写为代价。

## 3. 已确认的产品决策

### 3.1 产品模型

- 单机、单用户；
- 不登录；
- 不创建管理员或操作员；
- 不提供浏览器管理后台；
- 桌面客户端是完整产品；
- 配置、资料、记录、向量、编排和诊断默认在本机；
- 用户可连接本机服务或第三方服务；
- 项目作者不提供必需的控制服务器。

### 3.2 技术方向

- 使用 Tauri 2 替代 Electron；
- 使用 React + TypeScript + Vite 替代 Next.js UI/SSR/API Routes；
- Rust 成为本地业务和系统能力的唯一核心；
- React 不访问文件、数据库、密钥、进程或第三方服务；
- 第一阶段保留 C# AudioBridge；
- Python Agent 按垂直能力逐步迁入 Rust；
- Go Control API 不打包进客户端。

### 3.3 数据与密钥

- 非敏感配置保存在 JSON；
- 敏感值保存在 Windows Credential Manager；
- SQLite 不保存 API Key、Token 或 Secret；
- 资料原文、切片、向量、全文索引和状态都保存在同一个 SQLite；
- `config.json` 的复制和普通备份不携带密钥。

## 4. 不在范围内

第一阶段不实现：

- 多用户、团队、租户和权限；
- 远程管理协议；
- Web 管理后台；
- 项目作者托管服务；
- 自动同步多台电脑；
- 移动端、macOS 或 Linux；
- 扫描 PDF 的本地 OCR；
- 默认捆绑大模型、ASR、TTS 或 embedding 权重；
- C# AudioBridge 的 Rust 重写；
- 遥测；
- 默认保存会议原始音频；
- 自动把第三方服务切换为另一个收费服务。

## 5. 目标系统架构

```text
Windows 桌面客户端
├─ Tauri / Rust
│  ├─ 应用生命周期与安全 IPC
│  ├─ 配置和 Credential Manager
│  ├─ SQLite + sqlite-vec
│  ├─ 资料、知识库与会话
│  ├─ AI Runtime 与服务适配器
│  ├─ OBS、Windows 和进程管理
│  └─ 诊断、备份与迁移
├─ React / TypeScript / Vite
│  ├─ 工作台
│  ├─ 资料
│  ├─ 记录
│  ├─ 服务
│  └─ 设置与诊断
├─ 受控 sidecar
│  ├─ C# AudioBridge（第一阶段保留）
│  └─ Python Legacy Agent（迁移期临时保留）
└─ 用户选择的第三方服务
   ├─ Chat / Realtime 模型
   ├─ ASR / TTS / 音色服务
   ├─ Embeddings
   ├─ 可选 LiveKit
   └─ 可选对象存储
```

自有进程只通过 Tauri IPC、匿名管道或回环接口通信。自有 HTTP 监听必须绑定 `127.0.0.1`，不能开放局域网端口。

## 6. 页面信息架构

### 6.1 工作台

- 当前会话；
- AI 实时回复；
- 字幕；
- 人工接管；
- 音视频状态；
- 启动、暂停、恢复和停止。

### 6.2 资料

- 导入、删除和替换资料；
- 文本解析状态；
- 全文和向量索引状态；
- 重新索引；
- 搜索测试；
- 本地空间占用。

### 6.3 记录

- 历史会话；
- 对话、字幕和资料引用；
- Markdown、JSON 和纯文本导出；
- 单条和批量删除。

### 6.4 服务

- 模型服务；
- ASR、TTS 和 Realtime；
- 语音线路；
- 可选 LiveKit；
- Embedding 服务；
- 可选对象存储；
- 连接测试、状态和数据去向说明。

每一项独立选择本机或第三方 endpoint，不设置会掩盖细节的全局“本地/远程模式”。

### 6.5 设置与诊断

- 助手角色和话术；
- 声音与形象；
- OBS、虚拟摄像头和虚拟声卡；
- 配置文件和数据目录；
- 子进程、服务延迟和最近错误；
- 脱敏诊断报告；
- 备份、恢复和数据清理。

## 7. 配置设计

### 7.1 路径

开发环境默认：

```text
<repo>/config/local.json
```

仓库提交：

```text
<repo>/config/local.example.json
```

发布环境：

```text
%APPDATA%/AI Virtual Assistant/config.json
```

大体积本地数据：

```text
%LOCALAPPDATA%/AI Virtual Assistant/
├─ data/app.sqlite
├─ data/materials/
├─ data/avatars/
├─ data/voice-samples/
├─ data/exports/
├─ logs/
├─ runtime/
└─ backups/
```

### 7.2 配置定位优先级

```text
--config <absolute-path>
→ AI_VIRTUAL_ASSISTANT_CONFIG
→ 平台默认路径
```

除配置文件路径外，环境变量不覆盖业务字段。CI 通过临时配置文件运行。

### 7.3 配置结构

根类型为 `AppConfig`，必须包含 `configVersion`。主要分区：

```text
AppConfig
├─ ApplicationConfig
├─ ModelConfig
│  ├─ ProviderConfig[]
│  └─ ActiveModelSelection
├─ SpeechConfig
│  └─ VoiceRouteConfig[]
├─ TransportConfig
├─ KnowledgeConfig
├─ StorageConfig
├─ RoleProfiles
└─ DiagnosticsConfig
```

供应商与线路使用稳定 ID 引用，不能复制完整供应商配置到线路中。

### 7.4 配置读写

启动流程：定位 → 读取 → 按版本迁移 → 完整校验 → 建立只读运行快照。

保存流程：前端提交领域 patch → Rust 合并 → 完整校验 → 写临时文件 → flush → 原子替换 → 保存 last-good → 发布变更事件。

禁止前端发送整个配置对象覆盖磁盘。配置无效时进入修复模式，允许查看字段错误、打开文件、恢复备份、导入配置和恢复默认值；不得静默使用默认配置继续运行。

### 7.5 生效语义

- UI 偏好和日志等级可立即生效；
- 模型、语音和知识配置对下一次会话生效；
- OBS 与设备设置通过“应用并重新检测”生效；
- 活动会话持有不可变 `RuntimeSnapshot`；
- 第一阶段不允许修改数据目录。

## 8. 密钥设计

### 8.1 存储

Windows Credential Manager 是生产密钥的唯一持久化位置。Rust 使用 `keyring` 适配器访问。命名空间固定为应用 ID，entry 使用稳定 secret reference。

配置文件只保存：

- `secretRef`；
- `configured` 状态；
- 与密钥无关的服务参数。

SQLite、日志、诊断、备份、URL 和历史快照都不得保存密钥。

### 8.2 前端行为

- 新密钥只从前端提交一次；
- 保存后清空输入框；
- 前端只看到 `configured: true/false`；
- 不支持回显，只支持覆盖和删除；
- 普通参数保存使用 `keepExisting` 语义；
- 测试连接由 Rust 内部读取密钥；
- 删除供应商时清理不再被引用的凭据。

### 8.3 sidecar

密钥不得通过命令行或临时明文配置传递。优先由 Rust 代理第三方请求；迁移期确需传递时使用匿名管道，sidecar 退出后不保留。

### 8.4 生命周期

- 正常退出、重启、升级：保留；
- 普通卸载：默认保留；
- 删除服务：删除对应未引用凭据；
- 恢复出厂设置：删除本应用命名空间内全部凭据；
- 配置或备份迁移到另一台电脑：要求重新输入密钥。

## 9. Rust 与 React 边界

### 9.1 建议目录

```text
src/
├─ app/
├─ pages/{workspace,materials,records,services,settings}/
├─ features/{conversation,materials,models,speech,obs,audio,diagnostics}/
├─ components/
├─ hooks/
├─ api/commands.ts
└─ generated/bindings.ts

src-tauri/
├─ capabilities/
├─ migrations/
└─ src/
   ├─ main.rs
   ├─ app_state.rs
   ├─ error.rs
   ├─ commands/
   ├─ config/
   ├─ secrets/
   ├─ database/
   ├─ runtime/
   ├─ providers/
   ├─ speech/
   ├─ transport/
   ├─ knowledge/
   ├─ materials/
   ├─ sessions/
   ├─ audio/
   ├─ obs/
   ├─ processes/
   └─ diagnostics/
```

### 9.2 Rust 模块职责

| 模块 | 职责 |
| --- | --- |
| `config` | 定位、解析、校验、迁移和原子保存非敏感配置 |
| `secrets` | Credential Manager 与 secret reference |
| `database` | SQLite、事务和显式 migration |
| `runtime` | 不可变快照和 AI 会话编排 |
| `providers` | 第三方模型与存储适配器 |
| `speech` | ASR、TTS、音色和语音线路 |
| `transport` | Direct 与可选 LiveKit |
| `knowledge` | 切片、FTS、向量和混合检索 |
| `materials` | 文件导入、解析和生命周期 |
| `sessions` | 会话、轮次、事件和导出 |
| `audio` | AudioBridge 协议与 PCM 流 |
| `obs` | 专用 OBS 与虚拟摄像头 |
| `processes` | allowlist sidecar 生命周期 |
| `diagnostics` | 状态、脱敏日志和报告 |
| `commands` | 薄 IPC 层，不放业务逻辑 |

模块不得自行读取其他模块的存储。`speech` 不读取配置文件，`providers` 不查 SQLite，`commands` 不拼第三方请求，React 不启动进程。

### 9.3 前端限制

React 只负责页面、表单、渲染、导航、调用领域命令和订阅版本化事件。React 不得访问密钥、SQLite、任意文件、shell、第三方签名或重试策略。

Tauri capability 只授予具体业务命令，不提供任意读写文件、任意执行命令或任意启动进程的能力。

## 10. IPC 契约

所有命令使用统一结果：

```ts
type CommandResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        field?: string;
        retryable: boolean;
        requestId: string;
      };
    };
```

领域命令示例：

```text
config_get_public
model_provider_save
model_provider_test
model_provider_delete
speech_route_save
speech_route_test
speech_route_activate
material_import
material_reindex
material_delete
session_start
session_stop
session_export
runtime_get_status
diagnostics_export
```

版本化事件：

```text
runtime.status.v1
session.transcript.v1
session.reply.v1
audio.level.v1
diagnostics.event.v1
config.changed.v1
```

高频 PCM 不经过普通 JSON 事件，使用有界二进制 channel 或匿名管道。

Rust DTO 是唯一契约来源。使用稳定版 `ts-rs` 生成 TypeScript 类型；生成文件禁止手改，CI 检查生成结果无差异。命令调用集中在 `src/api/commands.ts`。

## 11. 服务适配器

Rust 业务层依赖窄接口：

```text
ChatModel
RealtimeModel
SpeechToText
TextToSpeech
EmbeddingProvider
ObjectStorage
Transport
```

适配器按协议而不是页面或品牌随意复制：

```text
providers/
├─ openai_compatible/
├─ openai_realtime/
├─ aliyun_realtime/
├─ aliyun_nls/
├─ volcengine_speech/
├─ local_filesystem/
├─ tencent_cos/
└─ livekit/
```

本机与云端 OpenAI-compatible 服务共用实现，仅 endpoint 不同。应用不自动切换供应商或收费模型。

## 12. Runtime 与音频链路

### 12.1 默认 Direct 模式

```text
AudioBridge
→ Rust Audio Pipeline
→ ASR 或 Realtime
→ 本地混合检索
→ Chat（级联模式）
→ TTS（级联模式）
→ 本机扬声器或虚拟声卡
→ React 字幕和状态事件
```

Direct 模式不创建 LiveKit 房间。

### 12.2 可选 LiveKit

LiveKit 只作为用户主动启用的媒体传输适配器。Token 由 Rust 本地签发，不依赖 Control API。迁移期保留 `subtitle.v1`、`agent.command.v1`、`agent.command.result.v1` 和 `agent.response.v1` 的语义。

### 12.3 语音线路

级联：ASR → 资料检索 → LLM → TTS。

端到端：音频 → Realtime → 返回音频与转写。

一次只能激活一条线路。当前会话不接受中途线路切换。

### 12.4 会话状态机

```text
idle → preparing → listening → thinking → speaking
                         ↑                    ↓
                         └────────────────────┘
→ stopping → completed
```

异常状态为 `recovering`、`blocked` 和 `failed`。状态只由 Rust Runtime 变更；事件带递增序号，前端丢弃旧事件。

### 12.5 背压与隐私

- PCM 格式写入协议；
- 使用有限容量环形缓冲；
- 落后时丢弃过期音频，不无限增长内存；
- 记录 underrun、overrun 和丢帧数；
- 默认不落盘原始音频；
- 人工接管立即停止 AI 输出；
- TTS 期间继续执行回声保护。

## 13. 启动、闸门与错误恢复

启动顺序：日志/目录 → Credential Manager → 配置 → SQLite migration → WebView2 → sidecar/OBS 检查 → 适配器 → 主窗口。

整体状态：

- `ready`：核心链路可运行；
- `degraded`：可选能力不可用；
- `blocked`：配置、数据库、音频等核心能力不可用。

会话开始前一次返回全部问题，不只返回第一个错误。问题包含稳定 `code`、所属 `area` 和前端 `action`。

重试规则：

| 错误 | 行为 |
| --- | --- |
| 配置、认证、额度 | 不自动重试 |
| DNS、超时、连接重置 | 指数退避，最多 3 次 |
| 429 | 遵守 `Retry-After` |
| 第三方 5xx | 当前操作最多 2 次 |
| 音频设备失效 | 重新枚举 1 次 |
| sidecar 崩溃 | 当前会话最多重启 1 次 |
| SQLite 写失败 | 停止会话并保护数据 |
| 知识检索失败 | 无资料上下文继续并明确标记 |
| TTS 失败 | 保留文本回复 |

所有长操作接受取消。用户停止会话时取消 ASR、LLM、TTS 和 Realtime，不等待完整超时。

允许的降级包括 embedding → FTS、TTS → 文本、外部存储 → 本地。禁止密钥缺失时使用作者密钥、配置损坏时读取旧环境变量、或供应商失败时自动更换收费模型。

## 14. SQLite 资料与向量设计

### 14.1 存储原则

单一 `app.sqlite` 保存：

- 资料元数据；
- 提取文本；
- 切片；
- FTS5 索引；
- sqlite-vec 向量；
- embedding space；
- 索引状态。

原始 PDF/DOCX 位于 `data/materials/`，数据库保存路径与 SHA-256。

### 14.2 核心表

```text
materials
material_documents
material_chunks
material_chunks_fts
material_chunk_vectors
embedding_spaces
```

`material_chunks` 保存 `chunk_index`、正文、hash、token estimate、字符偏移、section、embedding status。向量表以同一个 `chunk_id` 关联切片。

`embedding_spaces` 保存 provider、model、dimensions、distance、normalized 和配置 fingerprint。不同模型或维度绝不混合搜索。模型变化后旧向量标记 stale，新空间构建完成后原子切换。

### 14.3 导入流程

文件复制与 hash → 类型和限制检查 → 纯文本提取 → 确定性切片 → FTS5 → 批量 embedding → sqlite-vec → ready。

分两阶段可用：文本完成即 `text_ready`；向量完成为 `vector_ready`。Embedding 失败不破坏全文搜索。

### 14.4 切片

迁移现有 Go 的语义切片规则：优先标题、时间段、项目和段落边界，不从句中硬切。保存 `parserVersion`、`chunkerVersion` 和 `embeddingSpaceId`。相同输入与版本必须产生相同切片。

### 14.5 混合检索

FTS5 BM25 top 20 与 sqlite-vec cosine top 20 使用 Reciprocal Rank Fusion 合并，再去重、合并同资料相邻片段并产生最终 topK。

没有 embedding 或查询向量失败时只用 FTS。两者都失败时会话继续，但必须显示“本轮未使用资料”。

### 14.6 删除与替换

删除先禁止新检索，再在数据库事务中删除向量、FTS、切片、文本和元数据，提交后删除原文件。文件删除失败进入待清理队列。

相同 SHA-256 不重复索引。替换时先完成新版本索引，再删除旧版本。

### 14.7 依赖边界

向量扩展选用 `sqlite-vec`，精确锁定版本和源码校验值，并验证 Windows x64 静态或受控加载。当前仍为 alpha，升级必须显式评审。

不选 `sqlite-vector`，原因是其商业/生产许可可能阻碍未来用途。不在第一阶段使用新近的 SQLite Vec1。

PDF/DOCX 解析属于 Rust `materials`，不放在 React。实施前必须以真实中文 fixture 比较至少两种成熟方案，评估许可证、维护、文本准确率、畸形文件限制、Windows 打包和体积。扫描 PDF 第一阶段明确不支持 OCR。

## 15. 会话数据

核心表：

```text
sessions
session_turns
session_citations
session_events
runtime_snapshots
```

`session_events` 只保存重建业务状态所需的低频事件，不保存 PCM、电平和第三方原始响应。

Runtime snapshot 保存应用版本、配置版本、供应商 ID/协议/模型、语音线路、传输模式、角色 hash 和知识配置；不保存密钥、完整提示词或完整带查询参数 URL。

异常退出后，未完成会话标记 `interrupted`，保留已有轮次，但不自动重连会议或继续发言。

## 16. 数据保留、导出与备份

默认：会话文本保留到用户删除；诊断日志 14 天；声音临时样本完成后删除；PCM 与第三方原始响应不落盘。

“清除业务数据”保留配置和凭据。“恢复出厂设置”删除业务数据、配置、本应用命名空间凭据、专用 OBS 配置和运行缓存，但不修改用户自己的 OBS、其他应用凭据或外部导出文件。

会话导出支持 Markdown、JSON、纯文本。JSON 带 schema version，但不包含密钥、向量、完整资料或原始音频。

完整备份格式：

```text
manifest.json
config.json
app.sqlite
materials/
```

创建前执行 SQLite 一致性检查和在线备份；manifest 保存版本和 SHA-256；密钥不进入备份。恢复先在临时目录验证，成功前不覆盖当前数据。

## 17. 隐私与诊断

设置页必须列明数据去向：ASR 可能接收音频，LLM 可能接收转写/资料片段/提示词，TTS 接收回复文本，Embedding 接收切片和查询，LiveKit 接收媒体和数据，对象存储接收用户主动选择的文件。

诊断事件只记录稳定错误码、request/session/snapshot ID、provider ID、阶段、耗时和重试次数。禁止记录密钥、完整请求头、完整提示词、完整简历/对话、音频和第三方原始错误体。

本地删除不能声称已经删除第三方数据。支持远程删除的适配器失败后标记 pending，允许重试或仅忘记本地引用，并明确提示差异。

## 18. 现有代码迁移矩阵

| 当前区域 | 最终处理 |
| --- | --- |
| `server/management-web` | 页面能力迁入 React 后删除 |
| `server/control-api/internal/users`、`password`、`presence`、`audit` | 删除 |
| `server/control-api/internal/sessions` | 登录会话删除，业务会话迁 Rust |
| `server/control-api/internal/settings` | 迁 Rust `config` |
| `server/control-api/internal/secretbox` | 改 Credential Manager |
| `server/control-api/internal/resumes`、`knowledge` | 迁 Rust `materials/knowledge` |
| `server/control-api/internal/embeddings`、`objectstore` | 迁可选 provider adapter |
| `server/control-api/internal/livekittoken` | 迁可选 LiveKit adapter |
| `server/control-api/openapi`、`cmd/control-api-mcp` | 删除 |
| `server/deploy` 自有管理栈 | 删除 |
| `app/api/*` | 迁 Rust command/service 后删除 |
| `lib/database.ts` | 迁 Rust database 后删除 |
| `lib/runtime-config.ts` | 由 config + secrets 替代 |
| `desktop/*` | 迁 Tauri/Rust |
| `features/*` | UI 迁 React，系统逻辑迁 Rust |
| `native/AudioBridge` | 第一阶段保留 sidecar |
| `server/livekit-agent` | 迁移期 sidecar，最终删除 |
| Next.js | Vite SPA 等价后删除 |
| Electron | Tauri 等价后删除 |

## 19. Agent 迁移顺序

不按文件翻译 Python，按垂直能力迁移：

1. 配置和语音线路快照；
2. ASR → LLM → TTS；
3. say/retry/correct/report；
4. 字幕和回复事件；
5. Realtime WebSocket；
6. 可选 LiveKit；
7. 删除 Python sidecar。

每条链路使用同一音频 fixture 比较关键事件。新实现通过后默认切 Rust，旧实现只保留一个版本的显式回退，下一版本删除。

## 20. 迁移阶段与闸门

### 20.1 阶段 0：基线

建立能力清单、fixture、体积/启动/内存/CPU/磁盘基线和可追溯 Git tag。不新增功能。

### 20.2 阶段 1：Tauri 基础

完成 Tauri/Vite、错误模型、类型生成、配置、Credential Manager、SQLite migration、日志和 capability。Tauri 安装包可启动且不运行 Node server；Electron 仍是默认入口。

### 20.3 阶段 2：界面外壳

迁移五个页面入口和现有关键交互，使用 Rust 只读状态，不调用旧 Next API。

### 20.4 阶段 3：配置与服务

迁移 provider、模型发现、连接测试、语音线路、角色、LiveKit 和存储配置。旧管理端冻结只读。

### 20.5 阶段 4：资料与知识库

完成本地文件、解析、切片、FTS5、embedding、sqlite-vec、混合检索、备份和删除。不得依赖 PostgreSQL、pgvector、COS 或 Control API。

### 20.6 阶段 5：级联会话

完成 AudioBridge → Rust → ASR → 检索 → LLM → TTS，迁移会话状态、接管、记录、导出、取消和恢复。Direct 模式不需要 LiveKit。

### 20.7 阶段 6：OBS 与 Windows

迁移专用 OBS、虚拟设备、会议进程、前置组件和快捷键。只管理本应用登记的进程和路径。C# AudioBridge 保留。

### 20.8 阶段 7：Realtime 与 LiveKit

迁移 Realtime、可选 LiveKit 和 Agent commands。Direct 与 LiveKit 共用 Runtime。通过后默认关闭 Python Agent。

### 20.9 阶段 8：删除旧架构

确认全量等价后删除管理网页、Control API、自有部署栈、旧 API Routes、Next.js、Electron、Python Agent、登录和旧环境变量。

删除闸门：仓库不再引用 `CONTROL_API_ORIGIN` 或 `control_api_token`；安装包不启动 Node、Go、Python、PostgreSQL 或 Nginx；运行不访问项目作者地址；README 只有一种启动方式。

### 20.10 阶段 9：公开迁移版本

首次启动备份旧本地数据，在新目录迁移并验证后切换。远程服务器密钥、账户、登录 Session 和审计不自动迁移。用户重新填写密钥，远程资料通过显式导入。

## 21. 测试策略

### 21.1 Rust 单元测试

配置、SecretStore fake、状态机、切片、RRF、错误分类、重试、取消、脱敏、删除和 provider 解析。

### 21.2 数据库测试

空库/历史 schema migration、WAL 恢复、外键、FTS、sqlite-vec 维度、事务中断、备份恢复和损坏报告。

### 21.3 契约测试

生成类型无差异、命令名唯一、事件版本固定、公共 DTO 无 secret、错误码有 UI 动作、sidecar fixture 可解析。

### 21.4 前端测试

五个页面、字段错误、密钥状态、事件乱序、降级、键盘操作；禁止绕过 `src/api` 使用通用 Tauri API。

### 21.5 集成测试

新安装首会话、资料向量、FTS 降级、级联、Realtime、接管、sidecar 崩溃、OBS、异常退出、备份恢复、旧数据迁移和恢复出厂。

### 21.6 Windows 实机

Windows 10 22H2、Windows 11当前支持版本、普通用户、管理员安装、中文用户名、空格路径、离线、WebView2异常、多显示器/缩放、两种会议软件和设备切换。

第三方网络测试仅显式启用，不在普通 CI 使用真实密钥。

## 22. 性能验收

阶段 0 记录基线后确定数值门槛。最终必须满足：

- Tauri 主程序空闲内存显著低于 Electron；
- 不计 OBS/驱动的安装体积明显下降；
- 空闲时不常驻 Node、Go、Python服务；
- 音频缓冲和日志有硬上限；
- 畸形文档不会无限使用 CPU/内存；
- SQLite/embedding 不阻塞音频实时线程。

## 23. 回滚

迁移前创建带版本只读备份。迁移在新目录完成并验证后才切换数据指针。失败不修改旧数据，显示迁移错误和脱敏报告。旧 Electron版本不得打开新 schema；最后一个 Electron安装包和 Git tag 保留用于回退。

## 24. 仓库与交接规则

根级开发规则必须补充：

- UI 不访问文件、数据库、密钥、进程或第三方服务；
- Rust DTO 是 IPC 类型唯一来源；
- 禁止新增远程管理 API、登录、多用户和作者服务器依赖；
- 禁止在配置、SQLite、日志、fixture 中提交密钥；
- 新服务必须实现领域 adapter；
- 垂直迁移完成必须删除旧入口；
- 临时双实现必须写明删除阶段；
- 每个模块 README 说明职责、接口、允许/禁止依赖和测试位置。

每个迁移提交说明迁移能力、旧实现、等价测试、旧代码删除状态、剩余删除闸门、数据去向和费用变化。

## 25. 依赖决策摘要

| 组件 | 决策 | 许可证/备注 |
| --- | --- | --- |
| Tauri 2 | 采用 | 使用系统 WebView2，官方支持 Vite SPA 与 capability |
| React/TypeScript/Vite | 采用 | 复用现有 UI 技能和代码 |
| `keyring` | 采用 | MIT/Apache-2.0；Windows Credential Manager |
| `ts-rs` | 采用 | MIT；稳定 Rust → TypeScript DTO |
| `sqlite-vec` | 有条件采用 | MIT/Apache-2.0；alpha，锁版本/校验值/Windows 测试 |
| `sqlite-vector` | 不采用 | 商业/生产许可可能阻断未来用途 |
| SQLite Vec1 | 暂不采用 | 官方但新，后续复评 |
| Tauri Stronghold | 不采用 | 需要额外解决 vault 解锁密码来源 |
| `tauri-specta` v2 | 暂不采用 | 当前候选版本；先用 `ts-rs` |
| PDF/DOCX parser | 实施前选型 | 必须用真实中文和畸形文件 fixture 比较 |
| C# AudioBridge | 第一阶段保留 | 已有按进程 WASAPI 能力；不与主迁移同时重写 |

所有新依赖仍需在实施前复核稳定版本、许可证、维护、安全公告、Windows兼容、体积、资源、数据流和维护成本，并更新 `docs/dependency-decisions.md`。

## 26. 验收定义

架构迁移完成需同时满足：

1. 一个 Windows 安装包即可使用；
2. 无登录、管理网页或 Control API；
3. 非敏感配置本地保存，密钥进入 Credential Manager；
4. 资料、切片、向量、会话都在 SQLite；
5. 默认 Direct 模式不依赖 LiveKit；
6. 用户可配置本机或第三方服务；
7. 无项目作者服务器依赖或默认地址；
8. React 无系统级权限和持久密钥访问；
9. Rust 是唯一业务核心；
10. Python、Go、Node服务端和 Electron 已删除；
11. C# AudioBridge 是唯一允许保留的非 Rust 核心 sidecar；
12. 全量自动测试和 Windows实机矩阵通过；
13. 旧数据可安全迁移或回滚；
14. README、架构、依赖、安全和迁移文档与实现一致。

## 27. 实施前下一步

本设计批准后，下一步仅创建详细实施计划。计划必须按上述阶段拆成小型、可验证任务；先执行阶段 0，不直接删除旧系统或大规模翻译代码。
