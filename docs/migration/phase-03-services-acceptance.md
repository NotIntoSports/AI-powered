# Phase 3 服务配置验收记录

日期：2026-09-05

## 验收结论

Phase 3 第一批“服务供应商与语音线路本地配置”已完成并通过本地验收。桌面端可新增、编辑、测试、发现模型、启用和删除 OpenAI-compatible 供应商，也可配置级联 ASR/LLM/TTS 或端到端 Realtime 线路。线路必须通过供应商连通性和模型存在性检查后才能启用。

API Key 只通过一次性 IPC 输入进入 Rust，随后存入 Windows Credential Manager；公开配置、JSON、SQLite、日志、备份和前端返回值均不保存密钥正文。通用密钥读写 IPC 已移除。

## 已验收提交

- `a1bb84d`：实施计划。
- `a1a9cad`：有界 OpenAI-compatible 探测器（reqwest 0.13.4）。
- `6b32218`：供应商和语音线路领域服务。
- `52a5850`：Tauri IPC、类型绑定和最小权限。
- `f1dfadf`：服务配置界面。
- `1ba7e2c`：配置与密钥事务加固。
- `9c0c073`：最终验收修复和安全基线更新。

## 验收覆盖

- 配置写入串行化，主配置与 last-good 备份失败时保持一致。
- 供应商 URL 禁止用户名、密码、查询参数和 fragment，避免令牌落盘。
- Credential Manager 引用必须使用 `providers/{id}/api-key` 规范路径。
- 供应商保存失败时回滚密钥；删除后的密钥清理可安全重试。
- 免鉴权本地 OpenAI-compatible 服务支持 `configured=false`。
- 修改供应商会使所有引用线路失效并取消启用。
- 线路保存、测试、启用和删除串行执行；任何失败的复测都会取消启用。
- 旧版或手工写入的不完整线路不能绕过验证被启用。
- 测试按供应商去重发现模型，并核对线路填写的每个模型 ID。
- 服务端错误保留字段归属和可重试标志，界面显示字段错误。
- 模型发现结果可在语音线路模型输入框中选择。

## 验证结果

- `npm run test:tauri`：Rust 49 passed / 1 ignored；UI 77 passed；Tauri 合约 21 passed；前端生产构建通过。
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`：通过。
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过。
- `npm run tauri:build`：通过，生成 x64 NSIS 安装程序。
- `npm audit`：0 vulnerabilities。
- `cargo audit --no-fetch`：0 vulnerabilities；保留 16 条已有 allow/warning。在线 advisory 更新曾因 GitHub 网络 I/O 失败，随后使用本机缓存库完成扫描。
- Windows Credential Manager 显式 round-trip 测试：通过并清理测试凭据；常规测试默认忽略该副作用测试。
- 旧 Electron 桌面壳回归：183 passed。

## 依赖与限制

新增 `reqwest 0.13.4`，使用 `rustls`，许可证 MIT/Apache-2.0。客户端禁用默认特性、代理和重定向，设置请求超时，并将模型目录响应限制为 1 MiB。选择与调研记录见本地 `docs/dependency-decisions.md`（该文件按仓库策略忽略）。

本次没有使用真实付费供应商密钥做外部冒烟测试，因此不同厂商对 OpenAI `/models` 兼容性的差异仍需用户配置后现场验证。角色管理、LiveKit 传输和知识库/向量存储属于后续 Phase 3 批次，不在本验收范围内。
