# Phase 3 剩余服务与角色配置设计

**日期：** 2026-09-05

**状态：** 已确认，等待实施计划

**范围：** 助手角色、可选 LiveKit 与 Embedding 配置

## 1. 目标

补齐 Phase 3 尚未迁入 Tauri 桌面端的配置能力，使角色、Embedding 和可选 LiveKit 都由本地客户端管理，不依赖登录、管理网页、Go Control API、PostgreSQL、Nginx 或项目作者服务器。

本批次只建立经过测试、可供后续知识库和 Runtime 消费的配置与窄接口。资料导入、向量生成、会话运行、媒体传输和远程文件上传分别由后续阶段实现。

## 2. 产品边界

- 单机、单用户、不登录。
- 默认使用本地配置文件、本地 SQLite 和本地文件目录。
- LiveKit 默认关闭，由用户主动配置并启用。
- C# AudioBridge 继续作为受控 sidecar，不在本批改写为 Rust。
- 不修改任何服务器配置，也不提供远程管理协议。
- 不自动切换供应商、模型、传输方式或收费服务。
- 配置变更只影响下一次会话；活动会话继续使用其不可变快照。

## 3. 角色配置

### 3.1 数据模型

`RoleProfileConfig` 使用稳定 ID，包含：

- `id`：小写字母、数字、短横线或下划线，最长 64 字节；
- `name`：用户可见名称，不能为空；
- `systemPrompt`：系统话术，最长 32 KiB；
- `openingMessage`：开场白，最长 4 KiB；
- `styleInstructions`：语气和表达约束，最长 8 KiB；
- `active`：派生状态，必须与 `activeRoleProfileId` 一致；
- `configVersion`：每次保存递增，用于 Runtime 快照一致性。

角色内容属于用户业务数据，但不是认证密钥，保存在本地 JSON。公开配置 IPC 可以返回完整角色内容，因为设置页需要编辑；诊断、日志和错误不得复制话术正文。

### 3.2 行为

- 支持新增、编辑、复制、删除和设为默认。
- ID 创建后不可在编辑操作中隐式改名；复制生成由用户填写的新 ID。
- 删除活动角色会清空默认角色；不存在的角色不能被设为默认。
- 内置建议角色只作为首次创建时的本地模板，不形成第二套持久化来源。
- 后续会话开始时把角色 ID、版本和内容 hash 写入 Runtime snapshot，不保存完整话术到 snapshot。

## 4. Embedding 配置

### 4.1 数据模型

`EmbeddingConfig` 包含：

- `providerId` 与已有 `ProviderConfig` 引用；
- `modelId`；
- `dimensions`，范围 1 到 65536；
- `distance`，本阶段固定支持 `cosine`；
- `normalized`；
- `ready`、`status`、`configVersion`；
- `activeEmbeddingConfigId` 对应的单活动配置状态。

Embedding 继续复用 OpenAI-compatible 供应商与 Credential Manager 密钥，不复制 endpoint 或密钥引用。

### 4.2 测试与生效

- 保存时验证供应商引用、模型 ID 和维度范围，并重置 `ready=false`。
- 测试时由 Rust 获取密钥，验证供应商可访问且模型目录包含目标模型。
- 若兼容服务提供 embedding 响应，则发送固定、非用户内容的测试文本，验证向量为有限数值且维度完全匹配；不记录响应正文。
- 只有测试通过的配置可设为活动配置。
- 修改活动配置会取消活动状态；后续知识库阶段根据 provider、model、dimensions、distance、normalized 和协议版本生成 embedding-space fingerprint。
- 无 Embedding 配置不阻止应用启动；后续检索自动降级为 FTS5。

## 5. 可选 LiveKit 配置

### 5.1 数据模型与密钥

`LiveKitConfig` 包含：

- `enabled`，默认 `false`；
- `url`，只允许 `ws` 或 `wss`，禁止 userinfo、query 和 fragment；
- `apiKey` 的 Credential Manager 引用与 configured 状态；
- `apiSecret` 的独立 Credential Manager 引用与 configured 状态；
- `ready`、`status`、`configVersion`。

规范引用为 `transport/livekit/api-key` 与 `transport/livekit/api-secret`。密钥不进入 JSON、SQLite、URL、日志、诊断、备份、错误、前端返回值或 Git。

### 5.2 行为

- 保存普通字段时，空密钥输入保留现有凭据；非空输入覆盖对应凭据并立即清空前端输入。
- 任一配置或密钥改变都会重置测试状态。
- 启用前必须同时配置 URL、API Key、API Secret 并通过测试。
- 测试由 Rust 执行有界连接检查；本批次不创建持久房间、不发布媒体、不实现会话传输。
- 后续 Runtime 在本地使用 Key/Secret 签发短期访问 Token；Token 不持久化。
- 禁用 LiveKit 时默认 Direct 模式不读取 LiveKit 凭据。

## 6. 对象存储延期决定

S3-compatible 对象存储不在本批实现，也不加入运行配置和 UI。当前产品以本地 `data/materials`、`app.sqlite` 和本地备份为完整默认方案，不配置云存储也不会缺少核心能力。

配置模型只通过独立的 `StorageConfig` 分区保留未来演进边界，不预先加入 endpoint、bucket 或密钥字段。将来有明确的云备份或跨设备迁移需求时，再单独设计 S3-compatible 适配器、数据同步语义、冲突处理和远程删除策略。

## 7. Rust 边界

新增或扩展以下独立领域服务：

- `RoleProfileService`：角色 CRUD、复制、激活和版本；
- `EmbeddingService`：保存、探测、维度校验和激活；
- `LiveKitSettingsService`：双密钥事务、测试和启用；
- `EmbeddingProbe`、`LiveKitProbe`：协议窄接口，生产适配器与测试 fake 分离。

所有 Phase 3 配置写入与 Credential Manager 变更共用应用级服务锁。多密钥保存必须保存旧值并在配置提交失败时逐项回滚；回滚或清理失败使用稳定错误码暴露，不包含原始第三方响应。

Tauri commands 只做 DTO 转换和错误映射。React 只调用 `src/api/commands.ts`，不得直接访问网络、文件、SQLite、Credential Manager 或低级 Tauri API。

## 8. UI 设计

- “设置”页管理角色，提供角色列表、编辑器、复制、删除和默认状态。
- “服务”页增加 Embedding 和 LiveKit 两个区域。
- 密钥字段使用 password input、`autocomplete=new-password`，提交后在 `finally` 清空。
- 页面只显示“已安全保存/未配置”，永不回显密钥。
- LiveKit 明确显示默认关闭状态和媒体数据去向；Embedding 明确显示切片和查询会发送给所选供应商。
- 测试按钮展示有界状态；只有 `ready=true` 才能启用。
- 字段错误显示到对应区域，网络超时和临时连接失败标记为可重试。
- 不引入新的 UI 依赖。

## 9. IPC 与权限

新增命令：

```text
role_profile_save
role_profile_copy
role_profile_activate
role_profile_delete
embedding_config_save
embedding_config_test
embedding_config_activate
livekit_settings_save
livekit_settings_test
livekit_settings_enable
```

每个命令拥有单独 Tauri permission。不得恢复通用 secret set/delete/status，也不得新增任意 HTTP、shell、进程或文件系统权限。

Rust DTO 通过 ts-rs 生成 TypeScript；输入 DTO 可以包含一次性密钥字段，任何输出 DTO 都不得包含密钥正文属性。

## 10. 错误与隐私

- ID、URL、模型、维度、bucket 等输入错误返回稳定 code 和 `field`。
- DNS、timeout、connection reset 标记 `retryable=true`；认证、配置与配额错误不自动重试。
- 第三方响应正文、header、签名串、完整 URL、角色话术和密钥不得进入公开错误。
- Provider、LiveKit 和 Embedding 探测器设置显式 timeout、响应上限和禁止重定向策略。
- 配置、last-good、诊断导出和测试 fixture 必须通过密钥标记扫描。

## 11. 开源依赖决策闸门

实施前必须把调查结果写入忽略的 `docs/dependency-decisions.md`：

- 优先复用现有 reqwest 与协议能力；
- LiveKit 优先评估官方 Rust crates 或仅做 HTTP/WebSocket 有界探测；
- 检查稳定版本、许可证、最近发布与 issue、MSRV、Windows x64、安装增量、CPU/内存、网络数据去向、密钥处理和维护成本；
- 若成熟依赖明显过重，本批允许只实现窄协议探测器，但必须记录不采用现有方案的原因；
- 不复制大段第三方源码。

## 12. 测试与验收

- 领域单元测试覆盖全部 CRUD、引用、激活、版本、测试状态和配置回滚。
- fake secret store 覆盖双密钥部分失败、回滚失败和可重试清理。
- fake probe 覆盖成功、认证、timeout、维度错误和响应过大。
- 配置测试覆盖默认值、旧配置兼容、活动状态不变量和 URL 安全。
- IPC/权限/生成类型测试覆盖每个新增命令，并确保输出无密钥。
- React 测试覆盖编辑、空密钥保留、提交清空、测试后启用、错误和数据去向提示。
- 运行 `npm run test:tauri`、Clippy、Rustfmt、`npm audit`、RustSec audit、旧 Electron 回归与 Tauri Windows 安装包构建。
- 不使用真实付费 API 作为自动化测试；如用户未提供测试凭据，验收记录明确真实外部兼容性未验证。

## 13. 后续阶段接口

完成本批后按顺序进入：

1. 资料导入、解析、确定性切片、FTS5、Embedding、sqlite-vec 和混合检索；
2. Rust 会话 Runtime、记录、导出、备份和恢复；
3. Realtime 与可选 LiveKit 媒体传输；
4. 全量等价验收后删除 Electron、Next.js、Python Agent、Go Control API、管理网页和部署栈；
5. 根据最终体积、内存和稳定性数据单独决定是否用 Rust 改写 C# AudioBridge。

每个后续子系统拥有独立规格、实施计划、测试、审计和提交。最终切换前保留旧实现作为行为对照，禁止提前删除回退路径。
