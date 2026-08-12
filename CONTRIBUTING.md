# Contributing

提交功能前必须遵守 `AGENTS.md` 的开源优先流程，在 `docs/dependency-decisions.md` 记录许可证、维护状态、兼容性、成本、安全和维护取舍。不要提交密钥、候选人数据、下载的安装器、构建目录或本机配置。

提交前至少运行 `npm audit --audit-level=high`、`npx tsc --noEmit`、相关测试和 `npm run build`。
