# Mnemuron 核心功能优化方案 v0.2

> 执行对象：Mnemuron 核心源码与测试。
> 范围：现有核心功能的正确性、可靠性、检索质量、兼容性与可维护性。
> 明确延期：ChatGPT 网页端连接及其相关新功能。
> 方案版本不等于仓库软件版本。执行时须记录实际 HEAD 与测试基线。

## 0. 文档效力与使用方式

本文件保留核心优化的工程规范，不是执行记录或生产部署验收报告。实际实现进展见发布说明，具体运行结果应另行验证。

先阅读本文件和 `ACCEPTANCE_TESTS.md`，再从 CORE-OPT-00 开始核对。已有仓库 `AGENTS.md`、安全边界和更近版本的契约优先；本方案不得用来覆盖用户未提交的改动。

执行状态应存入私有 `EXECUTION_STATUS.json`，任务初始为 `not_started`。只有实际执行且有证据时才能更改为通过。文中的路径、API 字段和辅助函数需与当前源码核对。

**执行原则：先证明问题，再做最小修复；先修正确性，再优化性能；最后才做结构整理。**

---

## 1. 本轮目标及明确不做的事项

### 1.1 本轮必须交付

| 目标 | 对用户的实际价值 | 对应任务 |
|---|---|---|
| 检索范围正确 | 项目 A 的任务不会混入项目 B 的项目级事实 | 01 |
| 写入约束统一 | 绕过 Adapter 直接调 REST 也不能创建错误范围的记忆 | 02 |
| 写入可安全重试 | 请求超时后重试不会重复创建同一操作的记忆 | 03 |
| 旧记忆可检索 | 重要旧记录不被其他项目的新记录挤出检索范围 | 04 |
| 详情和截断明确 | 知道结果是否完整，并能按 ID 取回正文 | 05 |
| 同步故障可恢复 | 坏项、断网、限流、凭证失效可区分处理，不假报成功 | 06 |
| 维护与凭证更可靠 | 查询不顺带触发大规模清理，换钥失败不锁死 Agent | 07 |
| 改动可维护、可证明 | 小范围模块拆分、全量回归、增量迁移及恢复证据 | 08、09 |

### 1.2 本轮禁止扩展

不新增 `adapters/chatgpt-web/`，不新增 Remote MCP HTTP `/mcp`、OAuth、Cloudflare 配置、网页会话映射、浏览器扩展、网页投递状态机或网页全量采集。

不新增通用 Memory Proposal 审核平台、自动 LLM 记忆提取、Embedding、向量库、知识图谱、PostgreSQL 迁移、Redis 队列、微服务拆分或完整管理后台。

不把现有显式记忆保存全部改成 pending；不把 Canonical Task 的既有安全增量对账改成另一套产品流程。为未来网页端有用的能力，仅在它本身属于核心正确性修复时实施，例如服务端校验、幂等与受控详情读取。

不做生产部署、真实凭证轮换、线上数据清理、真实数据导出或自动设置 `production_ready=true`。不自动 push、合并 PR 或修改远程仓库设置。

### 1.3 不可破坏的既有不变量

1. Raw Events、Checkpoint、Structured Memory、Canonical Task、Resume Packet 继续分离。不能把一次检索当成恢复确认，不能把一次记忆保存当成 Canonical Task 更新。
2. Resume 的精确 ID/版本确认、当前会话证明、串行投递、回执核对、Stop ACK 和后续轮次不重复注入继续受保护。
3. Workstream 保留真实来源。其他 Agent 继续同一 Task 时不得冒充源 Agent，也不得自动合并分支。
4. `superseded` 和 `retracted` 默认不作为当前有效记忆返回；替代链、撤回记录及审计不丢失。
5. 网络异常不等于未写入；HTTP 2xx 不自动等于合法 ACK；没有证据的成功不得补造。
6. 原始未绑定事件仍可按照当前 capture 契约接收。不能把“正式记忆必须有合法范围”的校验直接套到所有原始事件上。
7. 同一 Session 可以在不同时间切换 Task。不能将 Session 设计成永久只属于一个 Task。
8. 本地检索/预览的“业务只读”允许必要访问审计和凭证使用时间记录，但不得改变任务、记忆生命周期、Scope、Resume 或保留策略。

---

## 2. 当前证据与待证明的问题

以下是源码级依据，不是对实际部署的断言。完整来源见第 14 节。

| 观察 | 当前位置 | 需要 Codex 证明或修复的内容 |
|---|---|---|
| 先从该用户记录取最近 500 条，再进行部分范围和相关性过滤 | `server/lib/store.mjs::queryMemories` | 跨项目候选挤占、同项目旧记录漏召回 |
| 只传 Task 时，过滤豁免 user/project scope | 同上 | 推导真实 Project 后再构造范围，复现跨项目污染 |
| 显式保存每次创建 UUID，插入和审计没有同一显式事务 | `saveMemory` | 有键重试幂等、事务回滚、响应丢失恢复 |
| Adapter 和核心的范围/长度校验不等价 | `memoryScope`、`saveMemory` | 所有写入入口使用相同核心规则 |
| 当前已有修订、撤回和来源字段 | 生命周期实现及现有测试 | 保留历史；不能因新索引使撤回内容重新成为当前事实 |
| 事件 outbox 对 413 隔离，其他失败会抛出 | `plugins/mnemuron/scripts/remote-client.mjs` | 分类错误、保留失败项、隔离因果队列、退避恢复 |
| 凭证使用时间每次认证都写库；换钥先撤销再签发 | `authenticate`、`rotateAgentKey` | 使用时间适度节流；换钥和审计原子性 |
| 本地会话和回执有严格已有契约 | `docs/chatgpt-core-foundation-v0.1.md` 等 | 只回归，不为未来网页端松绑 |

**若实际 HEAD 已修复某项：不要回滚后重新修。补对应回归测试，记录 `already_satisfied` 证据，仍完成任务验收。**

---

## 3. 实施阶段与提交边界

| 阶段 | 任务 | 优先级 | 前置条件 | 本阶段出口 |
|---|---|---|---|---|
| A：基线 | CORE-OPT-00 | P0 | 无 | 当前版本、基线测试、风险和兼容合同已记录 |
| B：正确性 | CORE-OPT-01～03 | P0 | A | 范围不串、写入校验完整、有键重试不重复 |
| C：检索体验 | CORE-OPT-04～05 | P1 | B | 全范围候选检索、历史召回、详情与预算可控 |
| D：运行可靠性 | CORE-OPT-06～07 | P1 | B；完成 C 更便于整体回归 | 坏项与凭证故障可恢复、维护边界清楚 |
| E：小范围整理 | CORE-OPT-08 | P2 | B～D 已通过 | 行为不变的模块化；不得阻塞前面修复交付 |
| F：验收 | CORE-OPT-09 | P1 | B～D 必须完成；E 做到何种程度必须列明 | 可复现回归、迁移与恢复报告 |

完整路线按 00→01→02→03→04→05→06→07→08→09 实施；若当前启动指令限定批次，只完成本批并报告，不自动跨批。每项可拆成若干小提交，但一个提交不要混合行为修复和大规模文件搬迁。禁止多个 Agent 同时直接编辑同一个 `store.mjs`；测试、文档工作可在明确边界下并行。

P0/P1/P2 表示开发排序，不代表漏洞的行业严重性等级。

---

## 4. CORE-OPT-00：冻结基线与兼容合同

### 范围

阅读 `README.md`、根 `package.json`、已有 `AGENTS.md`、核心正确性/生命周期/任务 Scope/ChatGPT 本地回执规格以及现有三类 Adapter 的 README。较早的通用 Scope 说明与较新的特定客户端交付规范不一致时，保留当前代码和最新验收测试的严格行为，记录差异，不能选更宽松的版本。

### 执行要求

- 记录 `git rev-parse HEAD`、工作树状态、Node/npm/Python/SQLite 实际版本、操作系统和测试环境。
- 如工作树已有用户修改，保留并记录；禁止 `reset --hard`、`clean -fd`、重置分支或覆盖用户文件。
- 使用临时目录、合成数据和回环地址进行测试。禁止读取真实 `.env`、真实凭证和生产数据库来构造公开 fixture。
- 先运行当前测试。根 `npm test` 已串联 Node 与 Hermes 测试，Node 部分失败时后面的 Python 部分不会自动执行；基线有失败时分别运行、记录两个部分，不能把“未执行”记成通过。
- 对每个审查风险添加一个最小失败测试；先记录失败原因，再修复。
- 检查目标运行时实际能否创建 FTS5 虚拟表，而不是只看 Node 主版本。能力探测只针对临时内存数据库，不安装新系统组件。

可直接使用的只读/测试命令：

```bash
git status --short
git rev-parse HEAD
node --version
npm --version
python3 --version
npm test
```

基线失败时，分别收集：

```bash
node --test --test-timeout=15000 server/test/*.test.mjs plugins/mnemuron/test/*.test.mjs adapters/openclaw/test/*.test.mjs
npm run test:hermes
```

已有 `test:capacity-local`、`test:failure-local` 脚本；先检查脚本如何选择数据库、网络和输出目录，确认不会指向真实部署后才运行。不要假定任意 `--dry-run`、`--db` 参数存在。

### 交付物

新增脱敏的 `baseline.md`、实际调用链/兼容合同说明；更新 `EXECUTION_STATUS.json` 的 `actual_head` 和运行环境。冻结新增测试的明确通过条件及性能评测环境。

### 验收

对应 B-01～B-05。已有失败不得删除、跳过或通过放宽断言掩盖。环境缺依赖要标为 blocked，而非“本项目测试通过”。

---

## 5. CORE-OPT-01：统一检索范围与对象关系

### 修改位置

`server/lib/store.mjs::queryMemories`、项目/任务/分支只读预览中适用的范围计算；优先抽出一个纯规则模块，例如 `server/lib/memory-scope.mjs`。不要在本任务重写整个 Store。

### 核心算法

```text
认证得到 user_id 和权限
    → 校验传入标识的格式
    → 按 user_id 查找显式 Task/Project
    → Task 推导真实父 Project
    → 校验显式标识之间是否矛盾
    → 构造业务检索范围
    → 在这个范围内检索及计算冲突
```

用户边界必须来自服务端认证，不能来自请求正文。查询 Task 不属于当前用户和 Task 不存在，应使用一致的不可见响应，不泄漏其他用户对象信息。

### 必须遵守的语义

| 查询条件 | 基础范围 |
|---|---|
| 不指定项目/任务 | 当前用户的记忆；仍受类型、生命周期和显式过滤限制 |
| 仅 Project P | 用户共享记忆 + P 范围中的记忆，不包含其他 Project |
| 仅 Task T | 由 T 推导 P：用户共享 + P 的项目级 + T 及其合法下级范围 |
| Project P + Task T | 只有 T 的真实父 Project 为 P 时才执行 |
| 指定 Workstream 集合 | 在上述合法范围内进一步过滤，不扩大 Task/Project 边界 |
| 指定 Session | 沿用现有 session-scope 过滤合同；不得把所有来源于其他 Session 的长期记忆误删 |

Task 查询不能仅因为一条记录 `scope=project` 就豁免父 Project 校验。同一个用户的多个 Agent 可以共享已授权记忆，不能把跨 Agent 读取错误地缩成“只能看创建者”。

**兼容注意：**现有 `memoryScope()` 可能向 user/project scope 记忆附带活动 Task、Workstream、Session 作为上下文。不要一概要求较高 scope 的附加字段必须为 NULL。区分“可见范围”与“来源上下文”；提供的对象组合需要一致，但附加字段不自动改变 scope。

**Workstream 注意：**当前 Workstream 可能来自 Task 的 `workstreams_json` 或已有事件/Checkpoint 中的 observed branch。不能假设存在独立 Workstream 表，也不能只允许已写入 canonical JSON 的分支。来源有歧义时要求精确 Task，不按字符串猜所属项目。

**Session 注意：**首次合法会话可能尚无中心端事件；没有记录不等于非法。允许当前契约下有认证来源的首次会话，同时拒绝已知矛盾的组合。不要引入每次写入前必须产生一条假事件的要求。

### `include_shared` 兼容决策

本轮不借机重定义该字段。先把既有行为写成测试：提供 `source_workstream_ids` 时沿用现有共享过滤规则；没有 Workstream 过滤时不新增隐式缩小规则。若其目前依赖 `workstream_id IS NULL`，保持兼容并在文档写清，未来再单独版本化 scope/provenance 的精细语义。

### 过滤适用范围

正文结果、摘要、冲突变体、候选计数和详情必须遵守相同的 user/业务范围。不能只过滤最后展示的前 20 条，让其他项目通过冲突列表或计数泄漏。

建议增加 `effective_scope`，说明服务端实际采用的 Project/Task 和推导来源；保留原 `filters` 用于兼容。

### 验收

S-01～S-12，尤其是仅传 Task A 查询、未知/他人对象、observed branch、动态 Session 切换及 user scope 兼容性。查询不会新建 Resume 或改变 Canonical Task。

---

## 6. CORE-OPT-02：核心写入校验与来源语义

### 修改位置

`saveMemory`、`supersedeMemory`、`retractMemory` 的共享输入验证；`server/lib/app.mjs` 的错误编码；现有本地 MCP、OpenClaw、Hermes 调用者的兼容测试。

### 统一验证合同

- body 必须是普通对象，不能接受 null、数组或字符串。
- content 必须是非空字符串。新显式保存与现有修订对齐，采用 4096 个 JavaScript UTF-16 code units 的上限；这与当前 `.length` 校验一致，不称为 token 数。存储可沿用 trim，不额外改写正文。
- scope 与 memory_type 使用现有枚举；不在本轮擅自加入新类型。
- topic 如提供，必须是非空字符串且不超过 120；不能通过截断掩盖非法超长输入。
- project/task/workstream/session scope 要求相应标识；能由合法下级对象推导的父级由服务端补充，而不是要求所有客户端重复提供。
- 所有显式提供的父子标识按 CORE-OPT-01 规则检查。user scope 仍允许没有任何项目/任务标识的记忆。
- auth 的 user/device/agent/agent_instance 为可信提交身份；正文中的同名字段不得覆盖它。
- HTTP 请求体限制与字段限制独立，直接调用 Store 也执行字段验证。
- 其他字段兼容性先盘点全部真实调用点：新保留身份字段拒绝伪造；其他未知字段按当前公开合同决定拒绝或忽略，并明确记录，不能悄悄接受其作为权限依据。

优先复用现有轻量验证函数，不为少数规则默认引入完整框架。若增加 Schema 依赖，应固定版本并提交锁文件，说明收益。

### 来源可信度：只澄清，不扩成审批平台

保留现有显式保存为 active 的业务流程。现有 `explicit-user-save-v0.1`、`confidence=1.0` 是历史接口语义，不能解释为“系统独立证明事实正确”。不批量改写历史来源或置信度。

可以新增服务端生成的来源解释字段，例如：

```json
{
  "verification": {
    "submission_identity": "authenticated",
    "content_evidence": "caller_submitted",
    "independently_fact_checked": false
  }
}
```

以上是建议字段，并非要求改动全部历史行。对已有来源关联可返回 `source_linked`，但事件可追溯也不等于事实经过独立核实。调用者声明的 `source` 只当标签，不能提高权限或证据等级；没有原始 Event 就保持为空，不创建假 Event。

本轮不引入 pending/approve/reject 工作流，也不加入 LLM 置信度重算。

### 错误返回

保留旧的 `error` 文本字段，增量补充机器可读 `error_code`，方便 Adapter 做安全错误分类。可采用：

| HTTP | 示例错误码 | 含义 |
|---|---|---|
| 400 | INVALID_PAYLOAD / INVALID_MEMORY_SCOPE / CONTENT_TOO_LONG / SCOPE_MISMATCH | 输入或组合不合法 |
| 401 | INVALID_CREDENTIAL | 凭证失效或被撤销 |
| 403 | INSUFFICIENT_SCOPE | 权限不足 |
| 404 | MEMORY_NOT_FOUND / TASK_NOT_FOUND | 不存在或对当前主体不可见 |
| 409 | IDEMPOTENCY_CONFLICT / LIFECYCLE_CONFLICT | 同一操作内容冲突或实体状态冲突 |
| 413 | REQUEST_BODY_TOO_LARGE | HTTP body 超限 |

不要向调用者返回 SQL、调用栈或其他用户标识。新错误码必须有契约测试，不能让客户端依赖不稳定自然语言字符串。

### 历史脏数据处理

新验证限制新写入，不通过启动迁移自动删除旧行。历史中无法证明范围的记录保留；默认带明确 Task 的查询不能把它猜进某个项目。生成受控诊断计数和最小 ID 清单，修复映射需另行明确操作，不能自动归并。

### 验收

V-01～V-10。绕过 Adapter 调用 REST/Store 都生效；非法请求不留下部分 Memory 或业务审计；错误审计如记录，应与成功创建审计区分。

---

## 7. CORE-OPT-03：显式写入幂等与审计原子性

### 必须实现的合同

给 `POST /v1/memories` 增量支持 `operation_id`；若同时支持 `Idempotency-Key` 请求头，两者同时出现且不同必须拒绝。键是一次用户操作的标识，不是内容哈希。键应是非空的受控 ASCII 标识（例如 UUID），最多 128 字符；不接受无限长或控制字符。

建议幂等唯一命名空间：

```text
(user_id, agent_instance_id, operation_type, operation_id)
```

选择 Agent 实例而非单个 credential_id，允许**同一实例正常换钥后**重试；每次仍必须验证当前有效凭证与权限。原操作记录保留原始 credential_id。不同实例或用户相同键不共用结果。

### 请求指纹

对经过类型校验、稳定默认值处理的请求意图做确定性序列化和 SHA-256。正文、scope、显式目标字段、类型、topic、来源标签等影响业务结果的内容必须参与；字段顺序、HTTP request_id、时间、Token 不参与。

请求意图与服务端推导后的有效目标分别记录。幂等重放不能因对象后续状态变化而把旧请求当成一个新写入。不要把结果中的 created_at 或随机 UUID 放进请求指纹。

| 情况 | 行为 |
|---|---|
| 同键、同意图 | 返回同一 memory_id，不重复创建或重复产生 memory.create |
| 同键、不同意图 | 409，原记录完全不变 |
| 不同键、相同正文 | 视为两个独立意图；不跨分支自动合并 |
| 没有键的旧调用 | 保持兼容，不宣称可防重复 |
| 已撤销凭证重试 | 401，不读取或重放历史结果 |
| 原记忆已被修订/撤回后重试 | 保持原操作引用，明确返回当前生命周期，不重新激活、不新建替代 |

### 事务要求

新增幂等记录表或等价结构，至少包含命名空间、请求哈希、实体 ID、原始提交身份、时间。不要存 Token；无需重复保存完整正文作为响应缓存。

```text
认证及输入校验
    → 进入短事务
    → 检查唯一幂等键及意图冲突
    → 写入 Memory
    → 写入相关索引投影（索引启用时）
    → 写入 memory.create 审计
    → 写入完成态幂等记录
    → COMMIT
    → 返回结果
```

SQLite 中采用事务和唯一约束，不用“先查后插但无约束”的方案。支持外层事务的调用点要用清楚的事务边界或 savepoint，避免嵌套 `BEGIN`。事务中不做网络请求。

插入、审计、幂等、索引任一步失败都回滚。提交后响应丢失时，重试返回原操作。重放返回原对象 ID和当前生命周期；不能简单返回缓存的 active 状态。

### Adapter 必须配合

操作 ID 在一个逻辑保存意图创建时生成，并贯穿该意图的网络重试；存在持久重试队列时先持久化再发送。不得在每次 HTTP 重试时重新生成 UUID。

本地 MCP 可增量暴露可选 operation_id；已有 OpenClaw/Hermes 中实际存在的保存入口同步处理。先盘点能力，没有该功能的 Adapter 不为凑齐矩阵新增记忆工具。

不同的模型工具调用，若没有同一操作 ID，不能被宣称成同一次重试；也不能用正文相同就猜测为重试。尤其不要只用一个可能复用的 JSON-RPC request.id 作为跨连接唯一操作 ID。

幂等记录不能被 raw retention 清理误删；撤回/替代也不能移除原操作键。本轮不做自动幂等键过期，以免旧操作重试变成新建。

本轮不实现所有 API 的通用幂等框架。先覆盖显式创建，保留修订/撤回和事件已有的幂等语义并回归。

### 验收

I-01～I-12。至少一个竞争用例使用两个独立数据库连接或子进程，不能仅用一个同步连接的 Promise.all 冒充数据库并发。故障注入仅存在于测试依赖或测试包装，不能增加公网/生产故障开关。

---

## 8. CORE-OPT-04：消除候选窗口盲区，增加可重建本地检索索引

### 必须改变的顺序

```text
当前用户 + 有效业务范围 + 生命周期/类型
    → 在该范围的全部可检索记录上做匹配
    → 按相关性选择有界候选
    → 既有相关性/范围/来源/时效重排
    → 结果数量和响应预算
```

不能用“把 500 改成 5000/50000”当作修复，也不能先全库 LIMIT 再过滤用户或项目。仅把范围条件挪进 SQL 仍不能解决同一项目内部超过 500 条后的旧记录漏召回。

### 建议的最小技术路线

保持 SQLite。优先验证 FTS5 + 可重建检索投影，不增加外部搜索服务。FTS 是候选生成机制，不是新的权威数据源；最终结果、生命周期、范围和冲突信息来自 memories 等原始表。

1. 用固定测试集做小型检索实验，记录实现选择到 `retrieval-decision.md`。
2. 推荐在应用层生成稳定检索文本：英文/数字词、中文连续字符的 unigram/bigram、保留完整型号/版本/序列号的专用 token。存储正文不改写。
3. 中文生成规则可用纯 JS，不默认引入本地 C 扩展或在线分词服务。查询端与索引端使用同一 `index_version` 的编码规则。
4. 若选择原生 trigram，必须额外处理 1～2 字查询；它的全文查询不能覆盖不足 3 个 Unicode 字符的子串。不要把“语音”“许可”这类查询全部变成零结果。[R8]
5. 用户查询先转为安全的字面词项，再绑定 MATCH 参数。参数化 SQL 不会自动消除 FTS 查询语言中的 OR/NOT/引号等语义，不能原样拼接用户输入。
6. 型号、IP、版本、序列号须有精确命中路径及测试。NFKC/大小写归一化只用于检索；不得把 `17.9.8` 与 `17.98`、不同 SN 合并成一个“精确”标识。
7. 候选上限可保留 500，但它必须是合法范围中相关匹配的候选上限，并给精确 ID/标识查询保留确定的命中路径。

FTS5 的 BM25 排序方向与常见“分越大越好”约定不同，若直接使用必须按官方定义处理；不得未经归一化就把它与现有 0～1 的分数相加。[R8]

### 结构和一致性要求

可新增检索文档投影表与 FTS 表，使用显式稳定的整数文档主键映射 memory_id。不要默认依赖可能随重建变化的隐式 rowid。具体 DDL 由 Codex 在理解现有迁移后确定。

新增显式记忆、Checkpoint 派生记忆、修订替代、撤回、管理导入等**所有实际写入路径**必须纳入一致性检查；不能只覆盖 saveMemory。记忆写入与其投影更新同事务完成，或采用可验证的失效标记使读取安全降级。更新/撤回后的查询再次以原表状态过滤。`INSERT OR IGNORE` 命中已有记忆时，投影须关联实际已存在的 memory_id，不能关联本轮生成但未插入的 UUID。

索引可丢弃重建，但 Raw/Memory/Checkpoint 不可丢弃重建。提供只操作测试库或明确目标路径的索引校验/重建管理入口，不公开给 Agent 普通工具。

### 迁移与降级

增量创建索引和投影，不删除 memories，不修改历史正文、ID、来源和生命周期。索引回填失败不能标记为 ready；重启可重试，旧数据仍在。

优先先修复合法范围内完整匹配的正确性，再接入索引优化。索引不可用时允许**明确标注的安全降级**：在合法范围内分批扫描全部必要记录并保留 bounded top-K；若超过工作预算则返回明确 incomplete/SEARCH_UNAVAILABLE，不返回伪装完整的空列表。不能降回“最近 500 条”。

降级扫描必须限制响应、候选缓冲和工作量；较大扫描应分批让出执行权或在受控工作执行器中完成，避免无限同步循环堵塞 HTTP 服务。可先提供可识别的不可用错误，不能为了始终返回 200 隐瞒未完成检索。

不允许旧/新核心二进制在 FTS 启用时并行写同库，除非已验证所有写入均能正确维护索引。回滚时关闭索引读取；重新升级必须校验/重建，不以“行数相同”证明索引正确。

### 检索解释字段

保留旧字段，增量加入类似：

```json
{
  "retrieval": {
    "engine": "sqlite_fts5",
    "index_version": "memory-search-v1",
    "coverage": "authorized_scope",
    "execution_complete": true,
    "candidate_limit": 500,
    "candidate_truncated": false,
    "result_truncated": false,
    "degraded": false
  }
}
```

`execution_complete` 仅表示本次所声明的查询计划已执行完，不保证语义上不存在任何其他相关事实。unknown 的计数或截断状态使用 null/明确状态，不伪造精确总数。原 `matched_candidate_count` 若仍只统计进入重排的候选，必须保留这个含义。

冲突检测只能在合法范围中呈现“已发现的潜在冲突”，不把有界候选中的无冲突说成全库无冲突；超限时返回 conflict_truncated/coverage 信息。

### 验收

R-01～R-15。包括跨项目 600 条噪声、同项目 600 条噪声、1～2 字中文、带符号的设备标识、索引回填/重建、派生写入、生命周期变化、FTS 不可用及查询字符安全。

---

## 9. CORE-OPT-05：单条详情、响应预算与截断说明

### 新增核心 API

```text
GET /v1/memories/:memory_id
```

要求 `memory:read`，按 auth.user_id 读取，不按创建者 Agent 独占。同用户跨 Agent 读取沿用现有共享模型。不存在与其他用户的 ID 都不泄漏正文。

默认只返回 active；显式历史读取可使用 `include_history=true`，但始终返回生命周期及替代链接，不能把历史条目包装成当前事实。保留已有 query statuses 的历史查询能力。

返回正文和最小来源，不把原始事件全量 payload、Token、任意本地路径自动展开。来源 Event 过期时明确 unavailable/expired；不可凭同一 ID 补造原文。

### 历史超长内容

新写入已有 4096 上限，历史记录可能超过。详情接口仍要受字节预算限制。对超大旧内容支持明确的片段读取，例如 `content_offset` + `content_limit`，指定单位为 Unicode code points，返回 next_offset/content_complete；或提供同等明确的受控读取合同。必须最终能分段取完整正文，不因历史长度直接无解释 500。

### 查询结果

保留 memory_id、现有 content/来源/生命周期结构；新增 `content_truncated`、原始长度、`detail_available`。摘要按完整 Unicode 字符边界裁剪，不能生成半个 surrogate pair。

128 KiB 继续作为字节级上限，所有正文、冲突 variants、来源列表和 JSON 包装开销都计入。超限时按照固定优先级缩短摘要、减少项并返回原因，不能业务查询成功后只因 JSON 过大变成 500。

本轮不增加面向特定模型的 Context Packet 或假精确 token 预算。字节和字符明确命名，不能把字符数冒充 token 数。

只读接口不触发 prune、对账、Resume 创建或 Scope 切换；认证/访问审计属于允许的运维写入。

### 验收

D-01～D-09。完整详情、其他用户不可见、历史显式读取、超长旧数据分段、中文/Emoji 边界、冲突体积预算与业务只读不变量。

---

## 10. CORE-OPT-06：可靠 outbox、错误分类与重试

### 范围

先修 `plugins/mnemuron/scripts/remote-client.mjs` 与相应 storage 队列状态。盘点 OpenClaw/Hermes 的既有 outbox/重试实现：存在相同问题的同步修复或实现相同合同；不存在相应能力的标为 N/A，不硬造工具。跨语言复用测试向量和错误合同，不要求 Python 导入 JS。

### 响应和错误必须先正确保留

远端调用应保留 HTTP 状态、允许的机器错误码、Retry-After 和安全诊断。HTML 错误页或非 JSON 不能覆盖原 HTTP 401/429/503 状态。为响应设置字节上限和总时限；仅有 socket inactivity timeout 不能限制一直滴流的响应。

不自动跟随可能把 Authorization 带到其他站点的跳转。TLS 校验不允许为测试方便永久关闭。默认日志不得包含完整正文、原始 payload、Authorization 或 API key。

### 错误策略

| 情况 | 状态/动作 | 禁止 |
|---|---|---|
| 网络错误、连接重置、超时、5xx | retry_wait；指数退避与抖动 | 删除原项或生成新事件 ID |
| 429 | 尊重有效 Retry-After，持久化下次重试时间 | 紧密循环重试 |
| 401/403 | 按凭证/接收端暂停并告警，凭证恢复后继续 | 大批隔离或删除正常业务事件 |
| 明确永久 payload 错误、已确认的 413 | 隔离坏项，保留原始包及原因 | 当作成功同步 |
| 未识别的 400/422、404、代理页、协议错误 | blocked_protocol / 配置诊断 | 仅凭状态码把整个队列全部当脏数据 |
| 409 | 根据业务合同对账；无法确认则 blocked_reconciliation | 把任何冲突都当成幂等成功 |
| 2xx 但业务 Receipt 字段不匹配 | blocked_reconciliation | 报告 ACK 或删除唯一回执 |

永久错误只依据明确的首方机器错误码、已冻结兼容错误合同或已确认的 body 超限判定。旧服务器返回自然语言错误时采用保守分类，不能写一组宽松正则去猜所有业务语义。

### 因果顺序和隔离

按现有会话/来源/回执依赖建立独立处理 lane。同一 Session 内的事件顺序和同一个 Receipt 的 delivered→acknowledged 顺序必须保留；不同独立 Session 的健康数据可以继续。

坏项隔离后，该 lane 有依赖的后续项默认暂停为 blocked_gap，其他 lane 不受牵连。若现有协议允许明确跳过某类非关键事件，必须记录 gap 并说明后续 Checkpoint 的证据不完整；不得静默跳过后仍宣称完整捕获。

缺少分组信息的老队列项放到保守的 legacy lane，不猜 Session。跨种类依赖以当前交付合同为准，不能只按“queue type 不同”就认为完全独立。

### 持久化和并发

保留不可变业务 envelope，重试状态用 sidecar 或等价元数据保存，至少包含：attempt_count、last_error_code、last_http_status、next_retry_at、first_failed_at、lane、状态。写入用原子替换；不得把 Token 复制进 sidecar。

同一项多进程同时 flush 要有可验证的 claim/锁，复用当前可靠模式而非新造分布式锁框架。死进程可恢复，活进程的锁不能仅凭 mtime 被抢走。状态损坏时保留文件并报告，不清空整目录。

处理成功后删除队列项之前，必须验证对应事件/回执确实已被服务端接受；回执 ACK 只在精确 Resume/Preview/Receipt/Attempt/Session 匹配后标记。提交后本地删除前崩溃，应通过服务端幂等安全重放。

明确可恢复分类不等于无限重试占满磁盘：提供高水位告警和阻塞可见性。本轮不静默丢弃最老事件，也不通过缩短保留期掩盖积压。

退避可采用配置化默认值（例如 base 1 秒、指数上限 5 分钟）；这些是新建议，不是当前实现。测试使用 fake clock 与固定随机源，禁止依赖真实长时间 sleep。合法 Retry-After 超过本地上限时，不应提前于服务端要求重试。

### 验收

Q-01～Q-14。必须覆盖重启、断网恢复、两 lane 隔离、认证暂停、HTML 429/503、坏 JSON、2xx 假回执、同时 flush 和业务提交后本地未删除的窗口。

---

## 11. CORE-OPT-07：维护边界、凭证事务与最小可观测性

### 11.1 从业务读取路径移出重清理

盘点所有 `pruneExpired()` 调用位置，只把查询/预览等不应承担维护任务的入口移除。复用已有 retention 管理入口和部署维护方式，不默认新增常驻调度平台。

**移除物理 prune 不等于允许读取已过期 raw 内容。**读侧仍依据 expires_at/expired_at 和现行保留政策投影来源可用性。Structured Memory 与派生 Checkpoint 按其自身合同保留，不因为原始证据过期就随意删除正式记忆，也不把它们冒充仍可访问的原始证据。

维护以受控批次执行，记录进度、耗时和失败；失败重试不影响已成功批次和来源 tombstone。保留期语义和原始证据保护边界不变。

### 11.2 凭证换钥原子性

`rotateAgentKey` 的旧凭证撤销、新凭证签发、必要审计放在一个事务里。签发或审计失败后，旧凭证仍有效；成功后旧钥失效、新钥有效，Agent 身份和权限不擅自扩大。对并发换钥的最终结果保持一致并测试。

不建立可通过幂等接口回读明文新钥的“钥匙缓存”。本轮只保证数据库操作原子性，不把网络投递新钥宣传成 exactly-once；响应丢失后的重新换钥/管理恢复流程在文档说明。

### 11.3 降低认证写放大但不缓存授权

可将 last_used_at 更新节流到例如 60 秒一次，用明确配置和条件更新。每次请求仍读取并校验撤销、过期和权限，不能缓存旧授权 60 秒；该字段只用于运维近似时间，不能承担精确访问审计。

### 11.4 状态输出

扩展现有 status/本地 Adapter status，而不是搭建新监控后台。区分：

- 服务端：数据库连通性、检索索引 ready/degraded、维护最近结果、受控错误计数。
- Adapter 本地：队列 pending/retry_wait/blocked/quarantined 数量、最老项年龄、最近成功同步时间、最近安全错误码。

服务端没有收到本地状态时返回 unknown/not_reported，不能把“没有数据”显示成 outbox=0。状态读取不触发 flush 或 prune。凭证、真实正文和完整用户查询不进入默认日志；诊断详情最小化且授权可控。

### 验收

M-01～M-09。移除查询清理后过期来源仍不可作为未过期原文返回；失败换钥可继续使用旧钥；撤销实时生效；业务只读快照保持稳定；未知本地状态不冒充健康。

---

## 12. CORE-OPT-08：最后做小范围模块化

此任务是 P2，可在独立提交继续，不得拖延已验证的核心修复。不是把大文件切成任意小块，也不是重写三类 Adapter。

### 推荐提取边界

优先提取本次新增/修改的纯验证、范围计算、查询 token 化和排序、幂等事务助手、响应投影。保持 `MnemuronStore` 的现有 public 方法作为 facade，调用方不因文件整理而整体改写。

可选新路径：

```text
server/lib/memory-scope.mjs
server/lib/memory-validation.mjs
server/lib/memory-retrieval.mjs
server/lib/memory-projection.mjs
server/lib/operation-idempotency.mjs
```

这些是职责示例，不要求五个文件都创建。已有相似模块优先复用。暂不搬动 Resume 状态机、Canonical Reconciliation 和全部迁移历史；更不引入多层泛型 Repository/Service/Manager 空壳。

若整理 migrate，保留既有版本逻辑和历史表结构可重入性，新的迁移有独立版本记录与失败边界。不要借机 ALTER/DROP/重建业务表。

### 验收

F-01～F-03。重构提交前后相同输入具有等价业务输出和数据库变化；例外仅限已单独验收的行为修复。依赖不循环、没有遗留两套各自不同的范围规则。

---

## 13. CORE-OPT-09：回归、迁移、恢复与交付

### 13.1 迁移准则

新表/列/索引均增量添加，重复启动不重复添加；新字段有兼容默认值。纯迁移测试要关闭会修改业务状态的维护流程，以便比较历史原始字段摘要。

迁移前后按稳定主键逐行比较**所有原有业务列**的哈希和行数，包含正文、来源、生命周期链、Raw/Event、Checkpoint、Canonical revision、Resume/Receipt；不要只比文件大小或总行数。单独允许并记录预计的新增投影/迁移记录，不把它们混进“原数据改变”。

使用仓库已有安全备份/恢复能力并核验输出。活跃 WAL 数据库不能仅复制 `.sqlite` 主文件当成一致备份；使用受支持的在线备份或已确认一致的停机副本。[R9] 这里只对合成库/隔离副本演练，不操作生产。

### 13.2 回滚准则

优先保留新业务数据并关闭新增可重建索引；只有在验证旧二进制兼容新 schema 且满足语义限制后才运行旧版本。**旧二进制即使能打开数据库，也会重新带回已修的范围或幂等问题，不能称为安全生产回滚。**

索引可重建，业务数据不可用空库替代。恢复迁移前备份会丢失备份后写入，必须记录这部分差异并保留新库副本；不得自动覆盖新库。不能“直接恢复旧备份”又宣称 RPO=0。

### 13.3 回归范围

核心 Node 测试、本地 MCP/Hook/锁/ACK 测试、OpenClaw 既有测试、Hermes Python 测试均纳入。新增测试按 `ACCEPTANCE_TESTS.md` 执行；没有对应功能的适配器用明确 N/A 原因，不声称三端完全等价。

增加两组集成路径：

```text
保存 → 同键重试 → 跨 Agent 查询 → 修订 → 默认查询排除旧值 → 撤回 → 显式历史读取
事件捕获 → 断网留队 → 恢复同步 → Checkpoint/Memory → 任务预览 → 既有精确确认/回执流程
```

第二组不得为“跑通”跳过本地 Hook 或伪造 ACK；仅通过现有测试 harness 模拟它本来可观测的事件。

### 13.4 检索评测和性能

使用合成中文/英文工程问法，至少 30 个固定查询，记录 expected IDs、forbidden IDs、Top-K 和理由。精确标识、项目隔离、生命周期为硬门槛：不得返回禁止项；指定精确目标必须命中。一般自然语言重排报告 Recall@5/10、MRR，不宣称词法检索已解决所有同义改写。

数据档位：功能测试至少覆盖 1200 条噪声；性能至少记录 1 万条，扩展记录 10 万条。报告硬件、Node/SQLite 版本、索引大小、冷/热查询、p50/p95、并发、写入耗时、事件循环延迟和峰值内存。

建议参考目标可设为“参考 2 vCPU/4 GB/本地 SSD、1 万条热查询 p95≤250 ms、10 万条 p95≤750 ms”，**这些不是实测结果，也不是跨所有设备的承诺**。应在基线阶段冻结与目标机器相符的门槛。环境无法满足或无法测量时报告事实，不事后悄悄调高门槛。普通 CI 不用苛刻 wall-clock 阈值制造随机失败，性能基准单独执行。

### 13.5 最终输出

交付 `implementation-report.md`，包括：实际起止 commit、完成/未完成任务、按文件变更摘要、真实命令与退出码、回归失败、迁移摘要、索引/恢复证据、性能、兼容性风险、延期清单。

原始测试日志使用明确目录保存；涉及本地身份或敏感数据的日志保持私有，不提交公开库。`EXECUTION_STATUS.json` 和报告相互一致，不能测试没跑却填写 passed。

无生产证据时保持 `production_ready=false`。本轮完成的准确表述是“核心优化已在列明的隔离环境中通过列明验收”，不是“已生产就绪”或“已经接通 ChatGPT 网页端”。

---

## 14. 来源与参考依据

[R1] 本仓库总说明：`README.md`。执行前另行记录实际 Git 基线，不将私人执行记录写入通用规格。

[R2] 核心实现：`server/lib/store.mjs`，重点为 `queryMemories`、`saveMemory`、`supersedeMemory`、`retractMemory`、`authenticate`、`rotateAgentKey`、迁移和各类写入路径。

[R3] HTTP 接口：`server/lib/app.mjs`；本地调用：`plugins/mnemuron/scripts/mcp-core.mjs`、`remote-client.mjs`、`storage.mjs`。路径与行为需对照当前源码核验。

[R4] 已有验收样例：`server/test/structured-memory-lifecycle.test.mjs`；根 `package.json` 中 Node/Hermes、capacity、failure 脚本。

[R5] 核心合同：`docs/structured-memory-retrieval-lifecycle-v0.1.md`、`docs/automatic-structured-memory-v0.1.md`、`docs/dynamic-task-scope-v0.1.md`。

[R6] 本地交付边界：`docs/chatgpt-core-foundation-v0.1.md`、`docs/chatgpt-mcp-delivery-receipt-v0.1.4.md`；名称出现 ChatGPT 不代表它是网页端适配。

[R7] 发布边界：`docs/production-readiness-v0.1.md`、`docs/production-readiness-evidence-matrix-v0.1.md`。

[R8] SQLite FTS5 官方文档：FTS 查询字面量、tokenizer、trigram 短词限制、BM25、索引一致性与 rebuild。
`https://www.sqlite.org/fts5.html`

[R9] SQLite 官方在线备份说明：
`https://www.sqlite.org/backup.html`

[R10] Node.js SQLite 官方 API；实施时以**目标 Node 24 的实际补丁版本能力**为准，不使用仅在更新主版本出现的 API。
`https://nodejs.org/api/sqlite.html`

[R11] 本对话上一版《Mnemuron_Review_and_ChatGPT_Web_Backlog.md》。本方案把其 CORE 问题细化，并明确延期全部 WEB 工作；上一版关于网页审批的建议不属于本轮执行授权。

---

## 15. 给 Codex 的最终约束

可以推进代码与测试，不要只重复输出计划。每完成一项更新执行状态与证据后进入本批下一项；本批结束后停止并报告；发生真实阻塞时先保留已完成改动，再做不依赖阻塞的工作，最终如实列出未完成部分。

不能靠关闭安全门、清空数据、删测试、伪造来源/回执、忽略失败、强制扩大权限或提前做网页端来“完成优化”。

**本轮完成条件：正确的范围、可靠的写入、可解释的检索、可恢复的同步，以及仍然成立的历史与任务连续性保证。**
