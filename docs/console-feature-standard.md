# 控制台功能开发标准

适用于 `web/console` 控制台的全部菜单页面。功能清单（`web/console/visuals.mjs` 中的 `featureMap`）和本文件一起构成开发标准：界面上的占位、系统状态页的「功能进度」、本文件末尾的功能表都来自这份清单。`services/oauth/test/console-feature-map.test.mjs` 会检查清单、界面、接口白名单、中英文文案和本文件是否一致，不一致时测试失败。

新增或调整功能时，先改清单，再写代码。

## 1. 功能清单字段

| 字段 | 含义 |
| --- | --- |
| `id` | 功能编号，格式 `ABC-00`。前缀按页面固定（见第 2 节），编号只增加、不复用。 |
| `status` | `live` 已上线 · `planned` 规划中 · `policy` 不开放（见第 3 节）。 |
| `read` | 读取的 console-api 视图名，浏览器请求 `GET /console-api/<view>`。 |
| `write` | 写操作名，格式 `<领域>.<动词>`，经 `POST /console-api/action` 提交。 |
| `core` | 规划中的功能将复用的现有 Core 接口。 |
| `scope` | 这些 Core 接口检查的权限。 |
| `reauth` | 写操作需要当前密码和一个未使用过的动态验证码。 |
| `operator` | 仅平台管理员可用。 |
| `ui` | 规划中功能的线框：`table` 表格列、`form` 表单字段（`类型:键`，类型为 `select`、`number`、`text`、`check`）、`submit` 主按钮、`actions` 其他按钮、`stats` 数字卡片。 |

文案不写在清单里。标题键是 `feat` 加去掉连字符的编号（`TSK-02` → `featTSK02`），说明键再加 `Note`（`featTSK02Note`）。线框里的列名、字段名、按钮名也是文案键。所有键都必须同时有中文和英文。

## 2. 页面与编号前缀

| 分组 | 页面 | 路由 | 前缀 |
| --- | --- | --- | --- |
| 我的空间 | 概览 | `/app/overview` | `OVW` |
| 我的空间 | 记忆库 | `/app/memories` | `MEM` |
| 我的空间 | 分类与摘要 | `/app/summaries` | `SUM` |
| 我的空间 | 项目与任务 | `/app/tasks` | `TSK` |
| 我的空间 | 接续交接 | `/app/resume` | `RES` |
| 我的空间 | 整理任务 | `/app/jobs` | `JOB` |
| 连接与设置 | 连接管理 | `/app/connections` | `CON` |
| 连接与设置 | 模型配置 | `/app/models` | `MOD` |
| 连接与设置 | 隐私与保留 | `/app/privacy` | `PRV` |
| 连接与设置 | 账户安全 | `/app/security` | `SEC` |
| 连接与设置 | 审计记录 | `/app/audit` | `AUD` |
| 连接与设置 | 存储与备份 | `/app/storage` | `STO` |
| 平台管理 | 注册码管理 | `/app/invitations` | `INV` |
| 平台管理 | 账户管理 | `/app/accounts` | `ACC` |
| 平台管理 | 系统状态 | `/app/system` | `SYS` |

「项目与任务」「接续交接」「隐私与保留」「系统状态」是原型页面：整页由清单生成，每个功能一张卡片，已上线的排在前面。已上线的卡片显示真实数据，也可以带真实操作；规划中的卡片显示线框和开发说明，不带任何操作。其他页面保留原有的真实功能，并在底部用「功能规划」列出本页规划中和不开放的功能。

## 3. 状态与流转

- **planned 规划中**：只有界面占位。线框里的控件全部禁用，不带 `data-console-action`，不发请求，不显示假数据或假的成功提示。`write` 里的操作名在服务端允许的操作集合中**不得**已经存在；测试会检查，避免规划中的功能被悄悄调用。
- **live 已上线**：有真实接口。`read` 视图由 BFF 提供并在 ingress 白名单内；`write` 操作在服务端允许的操作集合内。
- **policy 不开放**：有意不在网页端提供。说明文案写清楚原因和替代途径（例如运维在服务器上处理）。不得声明 `read` 或 `write`。
- **从规划中到已上线**必须在同一个提交内完成：实现接口、前端、测试，把清单状态改为 `live`，并同步本文件的功能表。
- 从 `policy` 改为其他状态，涉及安全或隐私边界，先在 issue 中讨论。
- 功能取消时保留编号，状态改为 `policy`，并在说明中写明原因。

## 4. 分层与数据流

```text
浏览器  app.mjs · actions.mjs · connections.mjs · visuals.mjs
  │  GET /console-api/<view>            POST /console-api/action（表单编码：csrf、account_id、operation_id、payload）
  ▼
BFF     services/oauth/src/console.mjs · console-policy.mjs
  │  会话与 CSRF、账户一致性、操作白名单与配置开关、限流
  ▼
Core    server/lib/console-read.mjs（读取视图）· server/lib/console/service.mjs（写操作）
        每个查询都按当前账户过滤
```

身份和账户类操作（`security.*`、`oauth.*`、`invitations.*`、`accounts.*`、`connections.*`）在 BFF 执行，其余写操作转给 Core。

## 5. 新增读取视图

1. **Core**：在 `consoleRead` 增加 `case '<view>'`，把允许的参数加入该视图的参数白名单。只查询当前 `user_id` 的数据；分页 `limit` 不超过 100；不返回密钥、凭证或其他账户的数据。
2. **Core 路由**：在 `server/lib/app.mjs` 的 `/v1/console/(...)` 列表中加入视图名。
3. **BFF**：在 `console.mjs` 的透传正则中加入视图名。BFF 自己的数据单独写处理函数，并在 `await` 之后调用 `ids.session(token,'console')` 复核会话。
4. **Ingress**：在 `docs/console-ingress.example.yml` 的 `console-api/(...)` 中加入视图名，并同步到 Cloudflare 隧道的路径规则。
5. **审计**：透传路径会记录 `console.read.<view>`；自写的处理函数自行记录。
6. **测试**：Core 单测覆盖账户隔离、分页和参数白名单；BFF 测试覆盖未登录和跨账户请求。

## 6. 新增写操作

1. **命名**：`<领域>.<动词>`，小写，多个词用下划线连接，例如 `retention.prune`、`memory.batch_classify`。
2. **注册**：Core 操作加入 `shared/console-contract.mjs` 的 `CONSOLE_ACTIONS`；身份和账户类操作加入 `services/oauth/src/console-policy.mjs`；两者都要受 `consoleActionAllowed` 的配置开关控制。
3. **实现**：同一个 `operation_id` 重放时返回原结果（幂等）。有版本的对象带 `revision` 或 `expected_revision`，冲突时返回 `VERSION_CHANGED`。失败如实返回错误码，不伪造成功。
4. **重新验证**：清单中标记 `reauth` 的操作，由服务端校验 `current_password` 和未使用过的 `otp`。
5. **限流**：沿用 `console:write:<账户>` 每分钟 60 次；批量操作限制单次数量，并逐条返回结果。
6. **审计**：记录账户审计事件，不含记忆正文和密钥。
7. **前端**：用 `actionButton(action, labelKey)` 生成按钮，只在 `canAct(caps, action)` 为真时显示；在 `mountActions` 的 `begin()` 中加入表单字段，在 `payload()` 中组装请求。
8. **错误码**：新的错误码在 catalog 中补齐中英文说明。

## 7. 新增页面

1. `web/console/routes.mjs` 加路由；`render.mjs` 的 `navGroups` 加菜单项；`visuals.mjs` 加图标（24 像素网格、1.5 线宽、方角）。
2. catalog 加页面名 `<page>` 和页面说明 `pageNote_<page>`，中英文都要有。页面 ID 不能与已有文案键重名（例如 `projects` 已是分类名，所以项目页用 `tasks`）。
3. 在清单中加入该页的功能；需要新前缀时，在第 2 节登记。
4. ingress：`app/(...)` 加入页面名，同步 Cloudflare 隧道的路径规则。
5. 浏览器测试的页面列表加入该页（`scripts/test-console-browser.py`、`scripts/test-console-connections.mjs`）。
6. 仅平台管理员的页面，在 `actionPage` 中判断 `operator`；对应接口在服务端独立鉴权。隐藏按钮不等于授权。
7. 新的浏览器模块必须同时加入 ingress 白名单，否则隧道后页面会一直停在「正在加载」；优先放进已有模块。

## 8. 界面规范

- 遵循 [console-design.md](console-design.md) 的令牌和组件。CSP 为 `style-src 'self'`：不写内联 `style`，不引入外部字体、脚本或图片。
- 所有文案经 catalog（`data-i18n`）输出，中英文齐全。动态值一律经 `html` 模板转义；只有本地固定的标记才用 `trusted()`。
- 每个数据区块都有加载、空和错误三种状态；某个卡片的数据读取失败时，只降级这一张卡片，不影响整页。
- 状态用形状加文字表达，颜色只作辅助：已上线为实心方块，规划中为空心方块，部分上线为半实心方块，不开放为短横。
- 表单控件都有 label；对话框可以用 Esc 关闭，关闭后焦点回到触发按钮；键盘能完成所有操作。
- 规划中的占位只用清单的 `ui` 描述，不手写假数据。

## 9. 安全与隐私红线

- 数据按账户隔离。平台管理员只能管理账户，不能读取他人的记忆，也不能代替他人操作。
- 响应、日志和审计中不出现密码、密钥、令牌或恢复码明文。一次性展示的新凭证除外，且只展示一次。
- 网页端不提供整库备份与恢复，也不提供删除账户（清单中为 `policy`）。
- 所有写操作都由服务端授权；前端禁用按钮不是授权。
- 模型外发必须经用户明确许可并受预算限制，不静默改用共享的付费模型。
- 接续的预览、确认、投递和完成回执是不同步骤，不能合并，也不能互相冒充。

## 10. 完成标准

一个功能从规划中改为已上线前，逐项确认：

- [ ] 清单状态改为 `live`，本文件的功能表同步更新
- [ ] Core 和 BFF 单测，包括越权和跨账户的负面用例
- [ ] `npm run test:oauth` 和 `npm test` 通过
- [ ] 浏览器测试（`console-browser` 工作流）通过
- [ ] ingress 示例和 Cloudflare 隧道规则已更新（新页面、新视图、新模块）
- [ ] 中英文文案齐全
- [ ] 相关文档已更新
- [ ] `node scripts/check-publication.mjs --worktree` 通过

## 11. 功能表

「读取」列是 console-api 视图名，「写操作」列是操作名。测试会逐行核对编号和状态。

| 编号 | 页面 | 功能 | 状态 | 读取 | 写操作 |
| --- | --- | --- | --- | --- | --- |
| OVW-01 | 概览 | 记忆分布与计数 | live | overview | — |
| OVW-02 | 概览 | 最近写入与 30 天活动 | live | overview | — |
| OVW-03 | 概览 | 待处理事项 | planned | attention | — |
| MEM-01 | 记忆库 | 检索与筛选 | live | memories | — |
| MEM-02 | 记忆库 | 详情、来源与修订历史 | live | memory, memory-meta | — |
| MEM-03 | 记忆库 | 新建记忆 | live | — | memory.create |
| MEM-04 | 记忆库 | 修订与撤回 | live | — | memory.correct, memory.retract |
| MEM-05 | 记忆库 | 分类、敏感级别与 ChatGPT 可见性 | live | — | memory.classify, memory.sensitivity, memory.visibility |
| MEM-06 | 记忆库 | 批量整理 | planned | — | memory.batch_classify, memory.batch_retract |
| MEM-07 | 记忆库 | 版本对比 | planned | memory | — |
| SUM-01 | 分类与摘要 | 分类索引与派生摘要 | live | summaries, summary | — |
| SUM-02 | 分类与摘要 | 生成分类与摘要 | live | — | jobs.schedule |
| SUM-03 | 分类与摘要 | 自定义分类体系 | planned | taxonomy | taxonomy.save |
| TSK-01 | 项目与任务 | 项目列表 | live | projects | — |
| TSK-02 | 项目与任务 | 任务与来源分支 | planned | task-branches | — |
| TSK-03 | 项目与任务 | 项目上下文预览 | planned | project-context | — |
| TSK-04 | 项目与任务 | 检查点与权威任务状态 | planned | task-checkpoints | — |
| TSK-05 | 项目与任务 | 新建项目与任务 | planned | — | projects.bootstrap, tasks.bootstrap |
| TSK-06 | 项目与任务 | 任务对账 | planned | task-reconciliation | tasks.reconcile |
| RES-01 | 接续交接 | 接续预览 | planned | resume-preview | — |
| RES-02 | 接续交接 | 确认接续 | planned | — | resume.confirm |
| RES-03 | 接续交接 | 投递与完成回执 | planned | resume-deliveries | — |
| RES-04 | 接续交接 | 接续历史 | planned | resume-history | — |
| JOB-01 | 整理任务 | 任务队列与执行状态 | live | jobs, job | — |
| JOB-02 | 整理任务 | 创建与定期计划 | live | — | jobs.schedule |
| JOB-03 | 整理任务 | 取消与重试 | live | — | jobs.cancel, jobs.retry |
| CON-01 | 连接管理 | 应用授权 | live | connections | oauth.revoke |
| CON-02 | 连接管理 | 个人连接 | live | connections | connections.create, connections.update, connections.rotate, connections.disable, connections.enable, connections.revoke |
| CON-03 | 连接管理 | Agent 实例与设备 | planned | agent-instances | devices.register, devices.rotate, devices.revoke |
| CON-04 | 连接管理 | 捕获健康度 | planned | capture-status | — |
| MOD-01 | 模型配置 | 整理模型与向量模型 | live | models | models.save, models.disable |
| MOD-02 | 模型配置 | 连通性测试 | live | — | models.test |
| MOD-03 | 模型配置 | 个人向量索引 | live | — | vector.schedule |
| MOD-04 | 模型配置 | 用量与预算 | planned | model-usage | — |
| PRV-01 | 隐私与保留 | 外发许可总览 | live | models | — |
| PRV-02 | 隐私与保留 | 新记忆默认设置 | planned | privacy-defaults | privacy.defaults |
| PRV-03 | 隐私与保留 | 数据保留策略 | planned | retention | retention.save |
| PRV-04 | 隐私与保留 | 清理过期数据 | planned | — | retention.prune |
| PRV-05 | 隐私与保留 | 删除账户与全部数据 | policy | — | — |
| PRV-06 | 隐私与保留 | ChatGPT 读取范围 | live | capabilities | memory.web_policy |
| SEC-01 | 账户安全 | 修改密码 | live | — | security.password |
| SEC-02 | 账户安全 | 更换验证器 | live | — | security.totp.begin, security.totp.complete |
| SEC-03 | 账户安全 | 轮换恢复码 | live | — | security.recovery_codes |
| SEC-04 | 账户安全 | 会话管理 | live | security | security.session.revoke, security.sessions.revoke_others |
| SEC-05 | 账户安全 | 登录记录 | planned | login-history | — |
| AUD-01 | 审计记录 | 账户事件时间线 | live | audit | — |
| AUD-02 | 审计记录 | 筛选与导出 | planned | audit | — |
| STO-01 | 存储与备份 | 个人数据导出 | live | export | storage.export |
| STO-02 | 存储与备份 | 导入为新记忆 | live | — | storage.import |
| STO-03 | 存储与备份 | 存储用量 | live | storage | — |
| STO-04 | 存储与备份 | 整库备份与恢复 | policy | — | — |
| INV-01 | 注册码管理 | 注册码清单 | live | invitations | — |
| INV-02 | 注册码管理 | 批量签发 | live | — | invitations.issue |
| INV-03 | 注册码管理 | 撤销 | live | — | invitations.revoke, invitations.revoke_batch |
| ACC-01 | 账户管理 | 账户清单 | live | accounts | — |
| ACC-02 | 账户管理 | 停用与启用 | live | — | accounts.disable, accounts.enable |
| ACC-03 | 账户管理 | 平台管理员角色 | live | — | accounts.role |
| ACC-04 | 账户管理 | 查看他人记忆 | policy | — | — |
| SYS-01 | 系统状态 | 平台开关 | live | capabilities | — |
| SYS-02 | 系统状态 | 服务健康 | planned | system-health | — |
| SYS-03 | 系统状态 | 版本与迁移 | planned | system-version | — |
| SYS-04 | 系统状态 | 备份状态 | planned | backups | — |
