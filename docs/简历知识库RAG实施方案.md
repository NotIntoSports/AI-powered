# 简历知识库 RAG 实施方案（客户端简历上传 → 知识检索）

> 本文档是给开发（含 AI 辅助开发）的完整实施规格。覆盖：简历上传后自动向量化入库、面试中按候选人回答检索简历知识、注入提问生成 prompt 的全链路。
> 实施必须遵守仓库根目录 `AGENTS.md`：开源优先、依赖决策记录到 `docs/dependency-decisions.md`、密钥不进前端和版本库。

---

## 0. 架构总览与既定决策

### 0.1 数据流

```
客户端上传简历（已实现）
  Electron/Next.js → POST app/api/resume → control-api POST /api/v1/client/resumes
  → 校验/存 COS/写 resumes 表（已实现）
  → 【新增】异步索引流水线：提取文本 → 切块 → 调 embedding → 写 pgvector

面试中检索（新增）
  候选人提交回答 → app/api/session（answer 分支）
  → 【新增】调 control-api POST /api/v1/client/knowledge/search
     （control-api 内部：query 向量化 → pgvector 余弦检索，按 resumeId 过滤）
  → 命中片段注入 generateNextQuestion 的 system prompt
```

### 0.2 已敲定的设计决策（不要更改）

| 决策 | 内容 | 理由 |
|---|---|---|
| D1 | 向量存管理端 PostgreSQL（pgvector 扩展），**不存客户端本地** | 知识是管理端资产，客户端多机同步不可靠 |
| D2 | embedding 计算在 control-api 侧（服务端），**不在客户端** | 向量空间必须单一可信源；客户端各自计算会因模型版本不一致导致检索错乱；密钥不下发到面试机 |
| D3 | embedding 模型：**BGE-M3**（BAAI/bge-m3，MIT 许可，1024 维，8192 token，100+ 语言） | 简历含中英文混排，需要多语言与跨语言检索能力；完全免费可本地部署 |
| D4 | embedding 推理服务：**HuggingFace Text Embeddings Inference（TEI）** 容器，内置进 compose | 与 RAGFlow 的"内置模型"同模式：`docker compose up` 一把拉起，模型权重首次启动自动下载到挂载卷缓存；部署方零额外安装、零密钥 |
| D5 | 检索失败降级：RAG 链路任何环节失败都**不得阻塞面试**，降级为无知识注入继续提问 | 面试是实时场景，可用性优先 |
| D6 | 首期只做"简历"这一类知识源；表结构预留通用知识库扩展（`source_type` 字段），题库/岗位知识文档入库为二期 | 控制首期范围 |

---

## 1. 现有代码事实（已核实，直接引用，不要重新发明）

- 简历上传链路：`app/api/resume/route.ts`（Next.js 代理，cookie `control_api_token`）→ control-api `POST /api/v1/client/resumes` → `internal/resumes/service.go` `Upload()`：文件校验（pdf/docx/doc、≤10MB、魔数嗅探）→ SHA256 → COS `PutObject`（objectKey 前缀 `resumes/`）→ 写 `resumes` 表 → 审计
- 对象存储凭证：`internal/settings` `GetStorage()` + secretbox 解密（`object_storage_configs` 表，仅 `tencent-cos`）
- AI 配置：`ai_provider_configs` 表（base_url/model/encrypted_api_key，secretbox 加密，singleton id='default'，带 config_version）
- 路由划分：`internal/httpapi/router.go` —— `/api/v1/admin/*`（browser session + 管理员）、`/api/v1/client/*`（`requireAnySession`，Bearer token）；客户端上传走 `/api/v1/client`
- 提问生成：`lib/llm.ts` `generateNextQuestion()`，调用点在 `app/api/session/route.ts` 三处（`retryQuestion` / `correctLastAnswer` / 默认 answer→next 分支）
- 会话 schema：`app/api/session/route.ts` `actionSchema` 的 `start` 分支：candidateName/roleName/jobDescription/interviewFocus/maxQuestions/consentConfirmed；会话数据在 `lib/interview.ts` `InterviewSession`，持久化于 node:sqlite（JSON payload）
- 迁移：goose 嵌入 SQL，`internal/database/migrations/`，当前最新编号 00005
- compose：`server/deploy/compose.yaml`，postgres 镜像当前为 `postgres:16`
- 客户端模型配置：`lib/runtime-config.ts`（DPAPI 加密，支持本地端点免密钥）——**本期 RAG 不复用它**，embedding 端点是 compose 内部服务，走 control-api 环境变量

---

## 2. 任务一：管理端基础设施改造（control-api + compose）

### 2.1 compose 变更（`server/deploy/compose.yaml`）

1. **postgres 镜像替换**：`postgres:16` → `pgvector/pgvector:pg16`。
   - 该镜像是同版本 PostgreSQL 官方镜像的 drop-in 替代，额外内置 pgvector 扩展；数据卷兼容，已有数据无需迁移。
   - 这是 pgvector 生效的前提，`CREATE EXTENSION vector` 需要镜像内已安装扩展库。
2. **新增 embedding 服务**：

```yaml
  embedding:
    image: ghcr.io/huggingface/text-embeddings-inference:cpu-1.9
    command: ["--model-id", "BAAI/bge-m3"]
    volumes:
      - embedding_models:/data
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost/health || exit 1"]
      interval: 5s
      timeout: 5s
      retries: 60
      start_period: 180s      # 首次启动需下载约 1.2GB 模型权重
    restart: unless-stopped
```

3. `control-api` 增加：
```yaml
    environment:
      EMBEDDING_BASE_URL: ${EMBEDDING_BASE_URL:-http://embedding:80}
      EMBEDDING_MODEL: ${EMBEDDING_MODEL:-bge-m3}
    depends_on:
      postgres:
        condition: service_healthy
      embedding:
        condition: service_healthy
```
4. `volumes` 增加 `embedding_models:`。
5. `server/deploy/.env.example` 增加 `EMBEDDING_BASE_URL`、`EMBEDDING_MODEL` 两行注释示例。

注意：TEI CPU 镜像内未必带 curl，healthcheck 命令按镜像实际情况调整（可改用 TEI 自带的 `/health` + wget，或以 `CMD` 形式探测）；实施时先手动验证一次健康检查命令可用。

### 2.2 数据库迁移（新增 `internal/database/migrations/00006_knowledge_base.sql`）

```sql
-- +goose Up
create extension if not exists vector;

create table knowledge_chunks (
  id bigserial primary key,
  source_type text not null,          -- 首期仅 'resume'；预留 'knowledge'
  source_id text not null,            -- resume.id（二期为知识文档 id）
  chunk_index integer not null,
  content text not null,
  embedding vector(1024),
  embedding_model text not null,      -- 记录生成该向量的模型名，入库时校验一致性
  candidate_name text not null default '',
  created_at timestamptz not null,
  check (source_type in ('resume', 'knowledge')),
  check (chunk_index >= 0),
  check (char_length(content) between 1 and 8000),
  check (char_length(embedding_model) between 1 and 200)
);

create index knowledge_chunks_source_idx
  on knowledge_chunks (source_type, source_id);
create index knowledge_chunks_embedding_idx
  on knowledge_chunks using hnsw (embedding vector_cosine_ops);

alter table resumes
  add column index_status text not null default 'pending',
  add column index_error text,
  add column indexed_at timestamptz;
alter table resumes
  add check (index_status in ('pending', 'indexing', 'ready', 'failed', 'skipped'));

-- +goose Down
alter table resumes drop column index_status, drop column index_error, drop column indexed_at;
drop index knowledge_chunks_embedding_idx;
drop table knowledge_chunks;
drop extension vector;
```

要点：
- 维度 **1024 写死**（BGE-M3 输出维度）。若未来换模型，必须重建全部存量向量，`embedding_model` 字段用于识别存量。
- HNSW 索引用 `vector_cosine_ops`，检索一律用余弦距离算子 `<=>`。
- `resumes.index_status` 五态：pending（未开始）/ indexing（进行中）/ ready（成功）/ failed（失败，index_error 记录原因）/ skipped（如 .doc 老格式无解析能力）。

### 2.3 settings 与配置

- embedding 端点**不进 settings 表**：它是 compose 内部固定服务，用 control-api 环境变量 `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL`（`internal/config/config.go` 读取），与 `ai_provider_configs`（面向管理员可配的对话模型）解耦。
- control-api 启动时不强制 embedding 可用（允许 embedding 服务慢启动），首次调用失败时按错误处理即可。

### 2.4 embedding 客户端封装（新增 `internal/embeddings/client.go`）

- OpenAI 兼容协议：`POST {EMBEDDING_BASE_URL}/v1/embeddings`，body `{"model": "<EMBEDDING_MODEL>", "input": [...]}`；TEI 的 cpu 镜像原生支持该端点。
- 约束：单批 ≤32 条；HTTP 超时：批量入库 30s，单条查询 5s；响应校验维度必须为 1024，否则报错（防止镜像被换后静默产生错误向量）。
- 无任何鉴权头（compose 内网调用）。

---

## 3. 任务二：简历文本提取与索引流水线（control-api）

### 3.1 新增包 `internal/knowledge/`

文件划分建议：
- `extract.go`：PDF/docx → 纯文本
- `chunk.go`：切块器（纯函数，便于单测）
- `indexer.go`：编排 提取→切块→批量 embedding→写库
- `service.go`：对外接口（IndexResume / Search）
- `store.go`：knowledge_chunks 读写 SQL

### 3.2 文本提取（依赖选型，按 AGENTS.md 记录到 `docs/dependency-decisions.md`）

| 格式 | 方案 | 许可证 | 说明 |
|---|---|---|---|
| PDF | Go 库提取文字层（候选：`ledongthuc/pdf`，MIT；或 `pdfcpu`，MIT） | 需实施时核实最新版与维护状态 | 仅支持有文字层的 PDF |
| docx | 自实现：stdlib `archive/zip` 解压 + `encoding/xml` 解析 `word/document.xml` 提取 `<w:t>` 文本 | 无新依赖 | docx 本质是 zip，解析成本低；避免引入许可证存疑的库（如 unioffice 为商业许可，禁用） |
| doc（老二进制格式） | 不支持，`index_status='skipped'`，index_error 说明 | — | 现有上传允许 .doc，但无法可靠提取；产品侧提示用户转存 docx/pdf |

约束与已知限制（写进 README 与审计备注）：
- 扫描件 PDF（无文字层）提取结果为空 → `index_status='failed'`，index_error="no extractable text (scanned?)"；OCR 不在本期范围。
- 提取后文本需做清洗：合并断行、去除连续空白、去掉页眉页脚类孤立短行（可简化为：按空白归一化 + 丢弃长度 <2 的行）。

### 3.3 切块策略

- 块大小目标 **500 字符**，重叠 **100 字符**，优先在句子边界（。！？!?；;\n）断开；找不到边界时硬切。
- 每份简历最多 **500 块**，超出截断并在 index_error 记 warning（正常简历远达不到）。
- 每块入库时 `content` 保持原文；`candidate_name` 冗余存入每块（检索返回时展示用，不参与 embedding）。

### 3.4 索引编排（IndexResume）

触发时机：`resumes.Service.Upload` 成功后**异步**触发（goroutine，独立 context，超时 5 分钟），不阻塞上传响应。

流程：
1. 用 CAS 语义更新 `index_status: pending→indexing`（`update ... where index_status in ('pending','failed','skipped')`，防重复索引）。
2. 从 COS 读回简历文件（复用 `objectstore` 的 Get/Presign 能力；若 ObjectClient 无直接 Get，可加 `GetObject` 方法）。
3. 提取文本 → 切块。空文本 → `failed`。
4. 调 `internal/embeddings` 批量向量化（每批 ≤32）。
5. 事务写入 knowledge_chunks（先 `delete from knowledge_chunks where source_type='resume' and source_id=$1` 再插入，保证重传同 id 幂等）。
6. 更新 `index_status='ready'`、`indexed_at`；写审计事件（新增 `audit.ActionResumeIndexed`，失败写 ResultFailure）。
7. 任何错误 → `index_status='failed'` + index_error（错误信息不含密钥、不含 COS URL）。

另提供管理端重试入口：`POST /api/v1/admin/resumes/{id}/reindex`（复用 admin 鉴权），将状态重置为 pending 并重新触发。

### 3.5 简历状态查询（客户端用）

新增 `GET /api/v1/client/resumes/{id}/status`（挂到 router.go 的 client 路由组）：
- 返回 `{id, indexStatus, indexError?, indexedAt?}`。
- 客户端在开始面试前轮询（间隔 2s，上限 60s）直到 ready/failed/skipped。

---

## 4. 任务三：知识检索接口（control-api）

### 4.1 接口定义

`POST /api/v1/client/knowledge/search`（client 路由组，`requireAnySession`）

请求体：
```json
{
  "query": "候选人最近一段回答，最多 2000 字",
  "resumeId": "可选；传了则只检索该简历的知识块",
  "topK": 5
}
```

响应体：
```json
{
  "chunks": [
    {
      "content": "命中的简历片段原文",
      "score": 0.83,
      "candidateName": "张三"
    }
  ]
}
```

校验：query 1–2000 字符；topK 1–10，默认 5；resumeId 必须存在且 index_status='ready'，否则返回空 chunks（不报错，降级语义）。

### 4.2 检索 SQL

```sql
select content, candidate_name, 1 - (embedding <=> $1::vector) as score
from knowledge_chunks
where source_type = 'resume' and source_id = $2 and embedding is not null
order by embedding <=> $1::vector
limit $3;
```

- 先按 `source_id` 过滤再算距离（单份简历几百块，性能无压力）。
- 分数过滤：丢弃 score < 0.3 的块（余弦相似度阈值，可按实测调整，做成常量）。
- embedding 服务不可用或超时（5s）→ 返回 `{chunks: []}`，HTTP 200，日志记 warning。**绝不向客户端返回 5xx 阻塞面试。**

### 4.3 二期预留（本期不实现，仅说明）

- 管理端上传知识文档（题库/评分标准）→ `source_type='knowledge'`，支持 `job_id` 元数据列（二期随文档表一起加）。
- 检索支持 `jobId` 过滤与简历+题库混合召回。

---

## 5. 任务四：客户端接入（Next.js 桌面端）

### 5.1 新增代理路由 `app/api/knowledge/search/route.ts`

完全仿照 `app/api/resume/route.ts` 的模式：读取 cookie `control_api_token` → 转发 `POST ${CONTROL_API_ORIGIN}/api/v1/client/knowledge/search` → 原样返回。无 token 返回 401。

### 5.2 新增 `lib/knowledge.ts`

```ts
export async function searchResumeKnowledge(input: {
  query: string;
  resumeId: string;
  topK?: number;
}): Promise<string>  // 返回拼好的参考知识文本；任何失败返回 ""（降级）
```

- 内部 fetch `/api/knowledge/search`，超时 8s（用现有 `lib/request-timeout.ts` 的 fetchWithTimeout）。
- 把返回的 chunks 拼成文本：每块前加 `- `；总长度上限 4000 字符，超出截断。
- catch 一切异常返回空字符串，console.warn 记录，不抛出。

### 5.3 会话挂载 resumeId

- `app/api/session/route.ts` `actionSchema` 的 start 分支新增：`resumeId: z.string().trim().max(64).optional()`。
- `lib/interview.ts` `InterviewSession` 类型新增可选 `resumeId?: string`；`resetSession` 透传存储（JSON 新增字段向后兼容，旧会话数据不受影响）。
- 开始面试 UI（stage 页启动表单）：增加可选的简历选择，选项来自新增的客户端列表接口 `GET /api/v1/client/resumes`（control-api client 路由组新增，复用现有 `resumeHandler.list`；仅返回已 ready 的简历）。选择后先轮询 status（见 3.5），再提交 start。

### 5.4 注入提问生成

`app/api/session/route.ts` 默认 answer→next 分支（约 213 行处），在 `generateNextQuestion` 之前：

```ts
const knowledgeContext = session.resumeId
  ? await searchResumeKnowledge({
      query: parsed.data.answer,
      resumeId: session.resumeId,
      topK: 5
    })
  : "";
```

`retryQuestion` / `correctLastAnswer` 两个分支：用"候选人最近一次回答文本"作为 query 同样检索（可抽一个辅助函数避免重复）。

`lib/llm.ts` `generateNextQuestion`：
- 入参新增 `knowledgeContext?: string`。
- systemPrompt 数组中、"岗位要求"之后插入：

```ts
input.knowledgeContext
  ? `候选人背景参考（仅供设计追问方向，禁止逐字念出、禁止在问题中直接引用原文）：\n${input.knowledgeContext}`
  : "",
```

- 与现有敏感信息约束不冲突：检索内容是简历事实，追问围绕经历核实本就符合现有 prompt 导向。

### 5.5 面试纪要（可选增强，默认不做）

`generateInterviewReport` 暂不注入知识。若二期需要，用同样模式处理。

---

## 6. 安全与合规要求（硬性）

1. 简历原文与向量均不出管理端：检索接口只返回命中片段文本，不返回 COS 地址、不返回向量本身。
2. 客户端代理路由只转发，不落盘简历内容；Next.js 侧不得把检索内容写入日志。
3. 审计：索引成功/失败、reindex 均写 audit 表（沿用现有 `audit.Store`）。
4. 检索接口的限流：沿用 client 路由现有中间件；topK 上限 10 防止滥用。
5. 不得把 embedding 端点暴露到公网：compose 中 embedding 服务**不映射宿主端口**（无 `ports`），仅 compose 内网可达。

---

## 7. 测试与验收

### 7.1 Go 侧（control-api）

- 单测：chunker 边界（句子边界、硬切、重叠、空文本、超长截断）；docx 解析（构造最小 docx fixture）；PDF 提取（有文字层 fixture + 空文字层应返回空）；检索 handler（resumeId 非 ready 返回空 chunks、topK 越界校验）。
- 集成：`internal/database/testdb_test.go` 模式下验证迁移 00006 可升降级（注意：测试库镜像也必须换成 pgvector 版本）。
- 冒烟脚本参照 `scripts/` 现有 test-* 命名习惯，新增知识检索冒烟。

### 7.2 客户端侧

- `npm run build`（含类型检查）通过。
- 手动验收路径（必须全走一遍）：
  1. 上传一份中文 PDF 简历 → status 轮询至 ready；
  2. 上传一份英文 docx 简历 → ready（验证多语言）；
  3. 上传一份 .doc → skipped；上传一份扫描 PDF → failed 且错误文案可读；
  4. 选择简历开始面试，候选人回答"我之前做过订单系统的性能优化" → 生成的追问应体现简历中对应经历（人工判断相关性）；
  5. 杀掉 embedding 容器后继续面试 → 提问正常生成（降级生效），不报错不中断；
  6. 不选简历开始面试 → 行为与现状完全一致。

### 7.3 性能验收

- 检索接口 P95 < 1s（含 query embedding）；超时 5s 硬上限。
- 单份简历索引全流程 < 60s（典型 2 页 PDF）。

---

## 8. 实施顺序与交付清单

1. compose + 迁移 + embeddings client（任务一）→ 手动验证 TEI 可出向量、pgvector 可建索引
2. 提取/切块/索引流水线（任务二）→ 单测通过
3. 检索接口 + status 接口（任务三、四服务端部分）→ 集成测试通过
4. 客户端接入（任务五）→ build 通过 + 手动验收 7.2 全过
5. 更新 `docs/dependency-decisions.md`：pgvector、pgvector/pgvector:pg16 镜像、TEI、BGE-M3、PDF 提取库的选型记录（许可证/维护状态/备选与否决理由）
6. 更新 `server/control-api/README.md` 与 `server/deploy/.env.example`

## 9. 明确不做（本期边界）

- 客户端本地 embedding / 本地向量库
- OCR（扫描件简历）
- .doc 老格式解析
- 题库/知识文档管理端 UI（二期，表结构已预留 source_type='knowledge'）
- rerank 重排序（先观察首期检索质量，必要时二期加 bge-reranker-v2-m3）
- 稀疏/混合检索（BGE-M3 支持 sparse，接口预留空间，二期按需）
