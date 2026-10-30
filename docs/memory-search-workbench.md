# 记忆图谱探索与搜索反馈

本批次补齐“找到记忆后是否能解释、能否反馈结果”的闭环。新增功能不修改来源正文，不自动合并实体、不新增模型外发，也不改变既有别名、精确标识或混合检索排名规则。

## 图谱范围与一跳探索

概览图继续是**关键词共现图**：同一条记忆中出现两个关键词，才构成共现证据。这不是实体身份、因果、拓扑连通性或事实核验。

- 所属项目可从分页项目列表选择，支持可选的精确任务 ID。项目与任务经 `resolveMemoryScope` 做 owner、生命周期和归属一致性校验；合并项目按 canonical member 集合读取。项目筛选只包含归属记录，不自动加入无项目的 user 记忆。
- 默认概览仍受 1000 条记录与 180 KiB 元数据预算约束，保留明确的返回数量和截断原因。全账户活动记忆及关键词覆盖统计不随图谱筛选变化，避免误报流水线进度。
- 点击关键词的“探索全库一跳关系”，或输入完整关键词，可查询当前授权范围内的全部符合条件记录。时间、类型、项目、任务和元数据条件全部先于限制执行；较老记录不会因为排在概览最新 1000 条之外而丢失。
- 关键词只做 NFKC、大小写和空白规范化。`Router/A` 不会自动匹配 `Router`，也不会据名称猜测实体或放宽版本号、地址等标识边界。
- 邻居列表最多 50 项，按当前共现记录数量排序，超过上限明确显示提示。仍可输入另一个完整关键词直接查看未列出的配对关系。
- 旧数据的超长关键词／主题不截短为另一个名称：在局部面板省略超长标签并显示提示，原始记忆与计数保留，证据仍可用 ID 打开；整个响应继续遵守元数据预算。
- 配对证据每页默认 10 条，允许 1–50 条；按最近记录活动与 ID 确定顺序。每页有总数、偏移和 `next_offset`；打开记忆走既有详情、来源和版本链接口，继续重新验证权限。
- `first_seen` 是符合条件来源记录的最早创建时间，**不是**关键词首次被标注的时间；`last_changed` 是这些记录或其关键词元数据的最近变化时间。
- 当前数量只计 `active` 记录，历史数量只计 `superseded` 记录，不是修订事件次数。默认不展示历史证据，勾选后才显示；撤回记录和已删除／不可用项目不进入共现图。版本替代 ID 单独标识，且需其自身仍属于可读的 live 项目，绝不冒充共现或来源关系。
- 页面筛选变化、重新渲染和账户切换会清理证据状态；迟到的旧请求不能覆盖新范围。读取失败不会假装空结果。

图谱使用现有 `GET /v1/console/attention`（BFF：`/console-api/attention`），新增参数：

| 参数 | 用途 |
| --- | --- |
| `graph_project_id` / `graph_task_id` | 精确项目／任务归属范围 |
| `graph_focus` | 完整、规范化匹配的中心关键词 |
| `graph_peer` | 可选配对关键词，须与 focus 一起使用且规范化后不能相同 |
| `graph_offset` / `graph_limit` | 一跳证据分页，不是概览采样分页 |
| `graph_history=1` | 明确包含已被替代的历史记录 |

已有 `graph_days`、`graph_kinds`、`graph_query` 继续适用。记忆库导航链接目前不承诺继承图谱时间、项目、任务条件，页面中有明确提示；精确范围内的完整证据应使用一跳证据分页。

## 显式搜索反馈

记忆库搜索结果中可以标记“相关／无关／已过时”，也可以记录“遗漏”。反馈只是用户评价，不是事实更正、训练许可或自动调整排序的指令。

- 每次搜索返回一个 30 分钟有效、owner 绑定的签名上下文，包含展示页内的 memory ID、当前 revision、排名、请求／实际模式、窗口限制和问题指纹。浏览全库而没有搜索时不创建上下文。
- 问题正文只在请求内参与 HMAC，**不写入反馈、回执或审计表，也不放进上下文 token**。每个账户有独立的持久随机 salt；不同账户的相同问题不能靠指纹直接关联。不要把 salt 或运行数据库上传到 GitHub。
- 查询指纹与筛选指纹分开。模式比较保留 requested/effective mode，避免将混合降级到词法的反馈算成成功语义检索；当存在向量 profile 时保留其指纹。
- 相关／无关／过时必须命中签名上下文里实际展示的 memory/revision，写入事务重新检查当前 owner、项目 liveness 和 revision。记录已改动、被撤回或项目被删除后，旧反馈上下文不能作为当前版本授权。
- 遗漏可不指定目标；如果指定期望 memory ID，会先按当前账户读取其 revision 再提交。目标不能是当前页已返回的同一版本。**遗漏仅表示当前展示结果窗口未见期望内容**，不意味着全库没有该内容，也不冒充已召回结果。
- 同一问题、筛选、请求／实际模式、profile、目标及 revision 只保留一条当前反馈，重复提交更新原记录。operation ID 回执保证网络失败重试不会重复写入；页面只有收到成功回执才提示“已保存”。
- 反馈历史按相同 owner/live 规则先过滤再统计和分页。记录内容变化后，旧反馈保留并明确标记来源有新修订；删除项目的反馈在普通视图中隐藏。未指定目标的遗漏只属于该账户。
- 页面计数是**显式人工反馈计数**，不是准确率、召回率或模型质量分数。不会开启 query cache、reranker 或新模型调用；这些优化需在单独对照验收证明收益后再显式启用。

`search.feedback` action 需要完整 Console 写入能力和 BFF 的账户绑定 CSRF；basic/read-only Console 不允许写反馈。它不改变权限／数据正文，不需要额外密码或 OTP；BFF 只接受 `search_token`、`memory_id`、`revision`、`feedback`，不会转发密码等额外字段。`GET /v1/console/search-feedback` / `/console-api/search-feedback` 是 owner-scoped 读取，支持问题／筛选指纹及最多 50 条分页。

## 数据与兼容性

新增两张可重复初始化的附加表：`console_search_feedback`（主键 owner + feedback key）与 `console_search_feedback_keys`（主键 owner）。不迁移、不覆盖原始记忆、来源、向量或版本链，无破坏性 down migration。反馈及其盐属于私有运行数据，由完整 Core 数据库备份保留；现有“仅记忆导出”不包含反馈历史。

这两张表是非权威遥测／哈希材料，不参与 canonical 状态或 lifecycle mutation epoch；所有引用目标的读写仍需现时生命周期检查。owner inventory 和 literal SQL lifecycle inventory 已纳入相应表及代码访问点。

## 可复现验证

离线验收复用原有 `qualityFixtureV3` 的冻结 8 条精确检索案例与 `rankMetrics`，不改变其标准，另加 owner 隔离、精确近似标识排除、13 条较老证据在 1002 条近期噪声之后仍可达、完整分页、指纹隐私、反馈去重与旧 revision 拒绝等 hard gates。

先准备已存在、权限为 `0700` 的私有证据目录，再执行：

```bash
node server/bin/mnemuron-search-workbench-quality.mjs --output /private/evidence
```

每次新建可丢弃的合成数据库，输出 `results.json` 与可阅读的 `results.md`。它不读取用户数据库、模型凭证或实际问题，也不访问网络。真实模型的压缩与向量检索质量仍须按既有 `mnemuron-memory-quality.mjs --edition v3` 的显式外发授权流程单独验收；离线通过不是生产认证或真实模型质量通过。

回归入口：

```bash
node --test server/test/console-memory-graph.test.mjs server/test/console-search-feedback.test.mjs server/test/search-workbench-quality.test.mjs
node --test services/oauth/test/console-memory-map-ui.test.mjs services/oauth/test/console-search-workbench-ui.test.mjs services/oauth/test/console-actions.test.mjs
# 实际浏览器，需设置 PLAYWRIGHT_MODULE / CHROMIUM_EXECUTABLE 等运行环境
node scripts/test-console-memory-map.mjs
node scripts/test-console-search-workbench.mjs
```

浏览器验收使用隔离 loopback Core、OAuth/BFF 和合成账户；覆盖项目／任务选择、历史证据分页、打开原文、迟到请求、反馈操作、模糊网络失败后的同 ID 重试、移动端与账户切换。不要对现网执行测试夹具。
