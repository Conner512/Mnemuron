# 模型配置与记忆处理

模型页复用现有 Organizer、Embedder、持久化任务和按账户向量索引，不新增身份平台、模型代理或共享凭证。

## 使用流程

1. 配置「分类与摘要模型」：选择 OpenAI 兼容或 Ollama，填写基础地址、模型名称、密钥、每日调用限额及输出上限。OpenAI 兼容基础地址通常以 `/v1` 结束，不填完整 chat/embedding 路径。
2. 明确选择允许处理的最高敏感级别，并批准外发。机密记忆不参与处理；此设置不改变云端连接的记忆可见性。密钥只写入当前账户的加密存储，空白保留；跨 origin 修改会清除旧密钥。
3. 点击「测试实际能力」。Organizer 用固定合成来源验证归类及有来源依据的摘要，各一次调用；不会读取个人记忆或发布测试结果为记忆。
4. 分别启动归类或汇总。汇总可选每日、每周或两者，可显式包含未结束周期；现有周期整理开关保留。原始正文、版本、生命周期、手动分类和 handoff 状态不被替换。
5. 配置「向量模型」，填写服务实际支持的维度。测试验证文档向量；仅在查询外发获准时再测试查询向量。查询未授权时明确列为未测试，不假称语义检索可用。
6. 启动个人向量索引并查看整理任务。完整构建后切换 generation，之后由现有 worker 增量同步。更换模型、版本或维度后旧索引不被当成兼容索引；语义检索需等待新索引完成。

保存配置和通过合成测试均不等于任务已执行。页面分别显示后台处理、向量后端、索引状态、索引记录数和语义查询条件。读取状态不会连接模型或向量库；这些状态是本地配置/处理记录，不是远程服务实时健康探测。

## 接口与存储

- 原有 `GET /v1/console/models` / `/console-api/models` 增加 `processing`，包含 classification、summary、vector 的运行阻塞项，以及个人周期设置。不会返回其他账户信息或 Qdrant 配置。
- 每个模型增加 `verification`，只显示当前配置 revision 的测试状态、检查项、固定错误码和时间；没有测试则为 `null`。
- 原有 `models.test` 新增可选 `mode: "capabilities"`。不传时保留旧的单次连接测试合同。所有调用仍计入既有每日预算和幂等操作回执。
- 能力测试最多两次，每次请求上限 15 秒，落在现有 BFF 40 秒预算内。配置在请求中途改变时拒绝结果，不给新配置打上旧的通过标记。
- 新增 `console_model_tests`，以 `(user_id, kind)` 为主键，携带 revision 和 attempt_id，更新受二者约束。不保存请求/模型输出正文、密钥或个人内容。修改配置会清除此条测试证据；中断超过 90 秒的 running 记录显示为 interrupted。
- 新表随现有 ConsoleState 幂等创建，旧表和数据不重建；账户归属清单同步补充。无需新增接口路由、依赖、Cloudflare 允许项或 MCP scope。
- BFF 仅新增固定模型诊断错误码透传，不转发上游错误正文、HTTP 头或凭证。

## 启用与部署边界

本次代码不自动开启生产配置。要执行处理，必须已有对应 `allowed_actions`、账户绑定凭证和加密存储；归类/汇总/向量构建还要求 `console.worker_enabled=true`。向量后端使用现有私有 Qdrant 配置；仅个人向量配置的安装需保持 `console.personal_vectors=true`。

不要为了开放模型配置而无审查地打开整个 `identity.console_operations`：它同时影响其他控制台操作。现有只具备基本记忆权限的账户仍不能操作模型/任务/向量，前端和服务端均保持限制。上线前须核对现有凭证与明确批准的操作范围，不自动扩大权限。真实模型计费、记忆外发、服务重启和上线验收分别需要授权。

`production_ready` 保持 false；恢复策略、管理员权限、MCP/handoff 安全约束不变。

## 本地验证入口

- `server/test/console-model-pipeline.test.mjs`：真实 loopback HTTP 模型合同，归类、来源摘要、向量、预算、版本竞争、账户/机密隔离；向量存储为测试专用 MockVectorStore。
- `services/oauth/test/console-models-ui.test.mjs`：角色说明、精确操作权限、阻塞提示和安全诊断渲染。
- `scripts/test-console-models.mjs`：现有 Playwright 运行时，真实 BFF、合成账户和数据；覆盖配置、测试、任务、语义读取、错误维度、双账户、1024/1440 布局。截图/结果只写库外 `MNEMURON_UI_EVIDENCE`。
- 原有 console、模型协议、worker、向量和隐私回归继续运行。上述合成测试不能宣称真实 Qdrant、真实模型、现网或 ChatGPT 端到端验收通过。
