# 控制台功能开发标准

适用于 `web/console` 控制台的全部菜单页面。功能清单（`web/console/visuals.mjs` 中的 `featureMap`）和本文件一起构成开发标准：界面上的占位、系统状态页的「功能进度」、本文件末尾的功能表都来自这份清单。`services/oauth/test/console-feature-map.test.mjs` 会检查清单、界面、接口白名单、中英文文案和本文件是否一致，不一致时测试失败。

新增或调整功能时，先改清单，再写代码。

## 1. 功能清单字段

| 字段 | 含义 |
| --- | --- |
| `id` | 功能编号，格式 `ABC-00`。前缀按页面固定（见第 2 节），编号只增加、不复用。 |
| `status` | `live` 已实现 · `planned` 规划中 · `policy` 不开放（见第 3 节）；代码能力不等于现网部署或外部验收。 |
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
| （无） | 概览 | `/app/overview` | `OVW` |
| 记忆 | 记忆库 | `/app/memories` | `MEM` |
| 记忆 | 摘要 | `/app/summaries` | `SUM` |
| 自动整理 | 整理能力 | `/app/processing` | `JOB` |
| 连接 | 连接 | `/app/connections` | `CON` |
| 工作 | 项目与任务 | `/app/projects` | `TSK` |
| 系统 | 模型与额度 | `/app/models` | `MOD` |
| 系统 | 健康 | `/app/health` | `STO` |
| 系统 | 审计 | `/app/audit` | `AUD` |
| 系统 | 账户安全 | `/app/security` | `SEC` |

导航按“记忆从哪来、怎么整理、被谁使用”分组。每个页面的地址与它的中英文标题一致（整理能力 Processing → `/app/processing`，项目与任务 Projects & tasks → `/app/projects`，健康 Health → `/app/health`）；代码里的页面键（`jobs`、`tasks`、`storage`）只在内部使用。公网入口（Cloudflare Tunnel）只放行这些路径，新增或改名的路径要先在入口规则里加。旧地址都会跳转：`/app/jobs`、`/app/system` → `/app/processing`，`/app/tasks`、`/app/resume` → `/app/projects`，`/app/storage` → `/app/health`，`/app/agents` → `/app/connections`，`/app/usage` → `/app/models`，`/app/entities` → `/app/memories`。单一所有者部署中：每项整理能力在「整理能力」页有自己的开关、依赖清单、状态和补处理入口，默认检索模式在语义检索卡片里；所有连接（ChatGPT、编程助手和其他应用）都在「连接」页；用量（调用次数与 14 天调用图）在「模型与额度」页。功能编号随内容移动：原 `CON-03`～`CON-05` 现为 `AGT-01`～`AGT-03`，原 `RES-01`～`RES-04` 现为 `TSK-07`～`TSK-10`，原 `SYS-01`～`SYS-04` 现为 `STO-05`～`STO-08`，`USE-01`～`USE-02` 在「模型与额度」页。

「项目与任务」是原型页面：整页由清单生成，每个功能一张卡片，已上线的排在前面。已上线的卡片显示真实数据，也可以带真实操作；规划中的卡片显示线框和开发说明，不带任何操作。其他页面保留原有的真实功能，并在底部用「功能规划」列出本页规划中和不开放的功能。

「隐私与保留」（`PRV`）、「注册码管理」（`INV`）、「账户管理」（`ACC`）三个页面已从 Console 移除：不在导航中出现，也不再渲染。旧地址 `/app/privacy`、`/app/invitations`、`/app/accounts` 由 BFF 以 303 重定向到 `/app`（概览），ingress 示例保留这三条路径只为让旧书签能到达重定向。这三个前缀的编号停用，不再复用。本次只移除网页入口，对应的服务端读取视图和写操作没有删除；是否下线由运维单独决定。注册码由 `services/oauth/bin/identity.mjs invite-*` 签发和撤销；平台管理员角色用 `console-operator.mjs grant-operator|revoke-operator`；多账户的停用与启用用 `console-operator.mjs disable-account|enable-account`（与原网页操作走同一条本地维护路径，最后一名平台管理员受保护）。新记忆默认隐私和数据保留没有网页或命令行入口，只能通过 Console 操作接口（`privacy.defaults`、`retention.save`、`retention.prune`）修改；新建记忆表单仍按账户已保存的默认值预填。

## 3. 状态与流转

- **planned 规划中**：只有界面占位。线框里的控件全部禁用，不带 `data-console-action`，不发请求，不显示假数据或假的成功提示。`write` 里的操作名在服务端允许的操作集合中**不得**已经存在；测试会检查，避免规划中的功能被悄悄调用。
- **live 已实现**：有真实接口。`read` 视图由 BFF 提供并在 ingress 示例白名单内；`write` 操作在服务端允许的操作集合内。实际环境的路由、开关、凭证和数据源必须单独验证，不以此状态冒充已部署。
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

### 8.1 关键词（MEM-08，替代实体关系）

- 参照 agentmemory 的 concepts：关键词写在每条记忆上（`memory_traits.concepts_json`，最多 8 个、每个不超过 40 字），不再单独设实体页面。旧的 `/app/entities` 跳转到记忆库。
- 记忆库：行内关键词是按钮，点一下列出所有带这个关键词的记忆（`memories?concept=`，大小写不敏感），筛选栏显示当前关键词并可清除；记忆详情里的关键词是同样的链接。搜索时，关键词包含查询词的记忆排在正文与语义命中之后一起返回（最多 200 条，仅限本人、仅限未删除项目）。`part=facets` 返回最常用的 30 个关键词。
- 概览记忆地图：被至少两条记忆共用的关键词成为连接点（最多 14 个），每条记忆连到它的每个关键词，并轻连到所属类型；没有共用关键词时退回主题，再退回类型。点开关键词看到图上的记忆数、常一起出现的关键词和“在记忆库里查看”。
- 补全关键词（`traits` 任务）：整理模型给还缺类型或重要度的有效记忆补上类型、关键词和重要度，每次调用 10 条，结果直接写入，不逐条审核；写入方或修订里已经填的字段不覆盖。单人模式下打开“补全关键词”开关后按自动处理节奏处理新记忆；“补全历史记忆”一次预览即可包含全部缺失记忆（上限 2000 条），确认一次后在后台跑完。模型输出在本地按完整约束校验，越界或换了修订的结果整批不写入。
- 实体相关的控制台操作（`entity.create/alias/alias_correct/alias_remove/link/unlink/resolve`）和实体提取任务的调度已移除；实体库与别名检索仍保留在服务端（现有数据保留，`entities` 读取视图仍按 owner 授权），审计里的历史实体操作仍归在记忆组。
- 回归入口：`server/test/memory-traits.test.mjs`、`server/test/console-memory-graph.test.mjs`、`services/oauth/test/console-library-ui.test.mjs`、`services/oauth/test/console-version-entity-ui.test.mjs`。

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

## 11. 本轮补齐的合同与边界

基础独立功能阶段已实现记忆、连接、用量、隐私及系统查看，未启用 handoff。后续任务工作流与 Hook 的接通范围见下方“任务创建、对账与接续联动”；代码实现仍不自动启用 handoff，`production_ready` 继续为 `false`。

### 接口与数据

- 新增只读视图：`attention`、`capture-status`、`model-usage`、`taxonomy`、`privacy-defaults`、`retention`、`memory-versions`、`task-branches`、`project-context`、`task-checkpoints`、`task-reconciliation`、`system-health`、`system-version`、`backups`；身份服务另提供 `login-history`。查询只接受固定参数，不接受前端 `user_id`。
- 新增操作：`memory.batch_classify`、`memory.batch_retract`、`taxonomy.save`、`privacy.defaults`、`retention.save`、`retention.prune`、`devices.register`、`devices.rotate`。沿用完整 console 写权限和功能开关，不扩展 basic credential、OAuth 或 MCP 的能力。
- 新增 `console_preferences`，主键为 `(user_id, kind)`；只存分类、隐私、保留偏好及其版本。启动时幂等建表，不改写既有身份、记忆、来源、生命周期或 OAuth 数据。已有数据库可重复初始化；回退代码时保留此表，不执行破坏性 down migration。
- 偏好变更要求 `expected_revision`。分类使用独立的账户版本；旧排队/运行中的整理任务被隔离并取消发布资格，旧摘要标记过期。旧分类任务不能通过重试绕过新版本，应重新调度。
- 批量操作每次 1～50 条，不允许重复 ID，逐条检查 owner 和已确认 revision；成功和失败分别返回，重放操作 ID 不重复修改，撤回不做物理删除。
- `memory-versions` 的正文分页按 Unicode code points，返回 `content_complete` 和 `next_request`。对比选择器列出最近 100 个版本，双栏读取选中版本完整正文并标记变化区域；超过读取上限时明确失败，不宣称完整。修订记忆可与被替代的上一条记录比较。
- 审计按 `action/outcome` 精确过滤及 UTC `from/to` 时间筛选，两侧数据库执行相同验证。导出只包含当前账户审计元数据，最多 100 页/16 MiB，不是数据库一致性快照，也不包含记忆正文或密钥。

### 隐私和权限

- 隐私默认值只记录“云端默认不可读”（不能设为可读）。敏感级别已取消，新建记忆不再自动设为私有：它们和其他记录一样，按账户的 ChatGPT 读取范围（全量读取、统一读取或逐版本授权）决定能否被读取。
- 保留设置只改变本账户未来捕获事件的默认值，已有事件的到期时间不变；显式事件级保留值仍遵守现有合同。记忆、检查点、权威任务状态不自动删除。
- 清理需要用户确认、当前密码及未复用的 TOTP；只清理本人已到期且没有固定来源 pin 的原始事件正文，保留元数据和来源链。默认每次 100 条，接口上限 1000；多批须逐次确认。不写全局运维状态，不清他人数据。
- Agent 密钥登记/轮换要求重新验证；普通只读/读写选择仍只授予 `memory:read` 或加上 `memory:write/capture:write`。Codex 插件另有明确的“插件完整功能”选择：`devices.register` 仅在 `agent_id=codex`、`access=read_write` 且 `task_continuity=true` 时额外授予 `resume:read/confirm`、`task:bootstrap:preview/confirm` 和 `project:bootstrap:preview/confirm`，用于创建与接续任务，不含管理权限。任务创建和 Resume 仍必须先预览、明确确认；交付与完成 ACK 继续独立校验会话、轮次和实例。省略该字段的旧客户端、其他 Agent 和只读密钥不会获得新权限；旧密钥也不会自动升级，需要重新生成并替换本机配置，随后撤销旧密钥。轮换保留已有权限，不增加权限。复用 Core 的加密操作回执和撤销机制；本轮新操作的密钥响应仅原登录会话可在 5 分钟内重试恢复，不接受前端提供会话绑定。平台管理凭证不能在这里轮换。
- 系统视图仅管理员可查看，BFF 在异步请求前后复核权限；平台管理员仍不能查看他人记忆。登录历史包括登录和敏感操作的重新验证；未知用户名及旧版未采集事件不伪造为当前账户记录。

### 未完成及环境边界

- `TSK-05～10` 已在下方“任务创建、对账与接续联动”中接通。原 `RES-01～04` 已并入 `TSK-07～10`，不再是独立待开发页面；这些操作仍遵守既有 handoff 门禁，代码实现不会替运维启用 handoff 或扩大已有凭据权限。
- `CON-04` 仅反映服务器实际收到的事件和处理状态。本机 Hook 超时、未发送队列没有可信上报入口，保持 `not_observable`，不是健康通过。
- `MOD-04` 显示当前个人模型配置的当日预留请求及预算，包含失败尝试；没有计费金额数据，不推算费用。`models.quota` 让账户所有者为整理模型和向量模型分别设置每日与累计调用次数上限（`null` 为明确的不限制，0 为不允许调用）；修改不清零计数，不改模型配置、索引、启用状态或任务。
- `SYS-02` 可验证当前 Core 数据库及搜索状态；worker、向量和 MCP 的配置/进程健康分开显示，没有探测证据时为 `not_probed`。`SYS-03` 的数据库版本是实际 SQLite `user_version`，不是完整的迁移审计报告。
- `SYS-04` 已有状态读取入口和说明，但可信备份记录源尚未接入，最近备份、大小及恢复验证仍为环境缺口。返回 `not_configured/verified:false`，不能算备份验收通过；不会启用自动备份或扫描整库文件。
- `policy` 项继续关闭。上线还需经授权部署代码、升级相应写凭证、核对新视图的精确 ingress 规则；本地代码和合成验收不会自动修改生产环境。

### 本轮验证入口

- Core：`node --test server/test/console-completion.test.mjs`，含所有者隔离、批量部分失败、版本/Unicode 分页、密钥回执与撤销、pin 保留、旧任务隔离、偏好重启持久化。
- BFF：`node --test services/oauth/test/console-actions.test.mjs services/oauth/test/console-feature-map.test.mjs`，含会话失效、管理员门禁、重新验证、接口清单、双语和日期筛选。
- 全量：`node scripts/test-all.mjs`；零测试、失败和未说明跳过均不能通过。
- 真实浏览器：`scripts/test-console-connections.mjs` 和 `scripts/test-console-completion.mjs`。通过已有 Playwright 模块及 Chromium 路径运行，仅使用本机合成 Core/OAuth 服务；报告及截图放 Git 外私有目录，不读取生产配置。
- 发布内容：`node scripts/check-publication.mjs --worktree`。不等于 Git 历史、GitHub 或生产个人数据审查。

### 记忆类型（替代分类）

- **由写入方选择**：保存或修订记忆时，Agent（ChatGPT、编程助手插件、控制台）可以带上 `kind`（`fact` 事实、`preference` 偏好、`workflow` 工作流程、`architecture` 架构、`bug` 问题、`pattern` 模式）、`concepts`（最多 8 个关键词，每个不超过 40 字）和 `strength`（1–10 的整数，界面默认显示“—”，建议值 7）。三项都可省略；不认识的类型、超长关键词或越界的重要度直接拒绝，不部分写入。
- **存储**：独立表 `memory_traits(user_id, memory_id, kind, concepts_json, strength, updated_at)`，启动时 `CREATE TABLE IF NOT EXISTS`，不改 `PRAGMA user_version`（仍为 12），旧版本打开同一数据库时忽略这张表。修订记忆时，旧记录的类型、关键词和重要度沿用到新记录，修订里带的字段覆盖对应项。
- **记忆库**：列为“记忆 / 类型 / 重要度 / 更新时间”；行内标签依次是项目、关键词、任务类型（`memory_type` 不是默认的 `fact` 时显示为“任务 …”）。筛选按类型，`kind=none` 列出未标注的记忆。`part=facets` 返回各类型计数（含 0）、主题、状态、来源和导入日期。唯一的批量操作是批量撤回。
- **概览**：类型构成色块条和图例，图例可直接跳到对应类型；流水线的“类型”一格显示已标注/全部有效记忆；记忆地图按类型着色。
- **已退役的分类功能**：单条分类（`memory.classify`）、整理到分类与撤销（`memory.organize`、`memory.organize_undo`）、批量分类（`memory.batch_classify`）、分类管理（`category.create`、`category.rename`、`category.delete`）、修改分类体系（`taxonomy.save`）、整理预览读取（`memories?part=preview`）、模型自动分类（`jobs.schedule type=classification`、单人模式的“自动分类”开关与处理类型）都已移除，请求返回 403/404/400。已有的分类数据（`memory_annotations`、`memory_category_overrides`、整理批次表）保留不删；旧的按分类生成的摘要仍可打开，并标注“旧版按分类”。旧的分类任务不能重试（`CLASSIFICATION_RETIRED`），审计里的历史分类记录仍归在记忆组。
- **一次性转换**：现有记忆从分类转换到类型是预览后由 owner 确认的一次性写入（只写 `memory_traits`，不改记忆内容和修订）。

### 任务创建、对账与接续联动（2026-10-29）

- **创建先预览后确认**：`projects.bootstrap_preview / projects.bootstrap_confirm` 创建项目及首个任务，`tasks.bootstrap_preview / tasks.bootstrap_confirm` 在明确选中的现有项目中创建任务。完整预览通过 `task-workflow-preview` 单独读取，绑定原 Console 凭据、到期时间、版本和项目生命周期；提交结果只有标识符和回执，不把冻结正文放进可重放的操作回执。重复项目、任务及待处理候选明确显示，不静默新建重复项。创建只建立 Console 自己的工作分支，不宣称某个 Agent 已接管。
- **任务对账要明确决策**：`tasks.reconciliation_preview` 冻结选择的检查点和权威版本，即便提案全部属于安全更新也不自动应用；页面展示各字段的前后值、冲突及来源。`tasks.reconciliation_resolve` 接受或拒绝的是整份提案，不是未实现的逐字段独立提交。并发的权威任务更新不会被旧提案覆盖；有冲突只能拒绝并重新生成。
- **接续要指定真实目标**：`resume-targets` 仅列出本账户已捕获的 Codex、OpenClaw、Hermes 会话，目标凭据必须仍具备 `capture:write / resume:read / resume:confirm`。浏览器只能选择服务器返回的 `target_event_id`，不能填写或冒充 Agent、实例、会话。会话最近被观察到不等于在线，界面不伪造心跳状态。
- **冻结来源与确认**：`resume.preview` 使用明确的任务和所选来源分支；`resume-status` 返回当前仍可读取的冻结预览、目标和阻断原因。来源修订、原始内容过期、项目删除/恢复、目标失效后，正文会被隐藏且旧授权不能继续投递。`resume.confirm` 只确认这个 ID/版本，成功表示 `queued`，不返回 Resume Packet，也不表示已经注入。
- **完整内容与响应边界**：冻结接续预览限制为 160 KiB，超过时整个预览事务回滚并提示缩小来源范围，不悄悄截断正文。详情与历史页限制为 240 KiB；详情按协议显示最多 20 项、24 KiB 的近期回执，同时给出真实总数及省略标记；历史用摘要及实际返回数量计算 `next_offset`，不会因字节分页遗漏记录。
- **实际交付与 ACK**：目标 Agent 在下一次正常工作入口调用 `POST /v1/resume/pending` 领取至多一份上下文；重复领取不记录投递。Codex 沿现有 `take_pending_resume` / delivery-receipt / Stop ACK 路径，OpenClaw 沿 `before_prompt_build` / injection-event / `agent_end` 路径，Hermes 沿 `pre_llm_call` / injection-event / `on_session_end` 路径交付。中央投递声明被接受前不返回上下文、不提前切换任务归属；完成先于本地上下文交付时不生成成功 ACK。临时失败保留重试状态，已明确失效的本地 Console 授权不能永久挡住新的预览确认。
- **历史与状态不混用**：`resume-history` 按账户和当前可用项目先过滤再分页，历史与详情区分“待确认 / 已排队 / 已投递 / 本轮已完成 / 失败 / 被阻断”。“本轮已完成”表示真实配对回执，不等于整个任务已经完成。只读、basic、hand-off 禁用及无可用目标分别显示真实限制，不返回假的成功。
- **重新验证与重试**：以上四个确认/解决操作均要求当前密码和未复用的 TOTP；两者只在 BFF 验证，绝不传入 Core。先核对预览或已完成操作的精确请求 hash、权限和来源，再消费验证因素；相同业务请求的响应丢失可用同一个 `operation_id` 与新的验证码重试，反向决策或修改请求不能复用 ID。无自动重试写操作。提交后列表刷新失败会保留已提交回执并明确提示。
- **存储与回退边界**：仅新增 `console_task_workflow_previews` 这一幂等初始化的 Console 预览表，不改变数据库 `user_version`、不重写旧业务记录。Resume 目标附着于现有冻结记录，确认状态承担持久排队语义，不另设第二个队列权威。部署应同时更新 Core、OAuth 静态资源/精确 ingress 和需要消费 Console 接续的 Agent 插件；旧插件不会被伪报为成功消费。回退不得把仍有新 Console 排队授权的数据库直接交给不了解目标绑定的旧 Core；先停止新增接续并在新版本核清/处理待投递记录，保留备份，不做破坏性 down migration。
- **验收入口**：新增 `server/test/console-task-workflows.test.mjs`、`server/test/console-resume-workflows.test.mjs`、`server/test/console-hermes-workflow.test.mjs`；Codex/OpenClaw 各自的 `test/console-resume.test.mjs`、Hermes 的 `test_console_resume.py`；BFF/UI 的 `console-actions.test.mjs`、`console-task-workflows-ui.test.mjs`；真实浏览器 `scripts/test-console-task-workflows.mjs`。所有运行仅使用合成身份、临时库和回环地址，`production_ready` 仍为 `false`。

## 12. 功能表

「读取」列是 console-api 视图名，「写操作」列是操作名。测试会逐行核对编号和状态。

| 编号 | 页面 | 功能 | 状态 | 读取 | 写操作 |
| --- | --- | --- | --- | --- | --- |
| OVW-01 | 概览 | 记忆分布与计数 | live | overview | — |
| OVW-02 | 概览 | 最近写入与 30 天活动 | live | overview | — |
| OVW-03 | 概览 | 待处理事项 | live | attention | — |
| MEM-01 | 记忆库 | 检索与筛选 | live | memories | — |
| MEM-02 | 记忆库 | 详情、来源与修订历史 | live | memory, memory-meta | — |
| MEM-03 | 记忆库 | 新建记忆 | live | — | memory.create |
| MEM-04 | 记忆库 | 修订与撤回 | live | — | memory.correct, memory.retract |
| MEM-05 | 记忆库 | 类型 | live | memories | memory.correct |
| MEM-06 | 记忆库 | 批量撤回 | live | memories | memory.batch_retract |
| MEM-07 | 记忆库 | 版本对比 | live | memory-versions | — |
| MEM-08 | 记忆库 | 关键词筛选与地图 | live | memories | — |
| MEM-09 | 记忆库 | 候选审核工作台 | live | review-candidates | review.extract, review.candidate |
| MEM-10 | 记忆库 | 记忆对照与人工复查 | live | memory-review | review.verify, review.resolve |
| SUM-01 | 摘要 | 摘要列表 | live | summaries, summary | — |
| SUM-02 | 摘要 | 生成摘要 | live | — | jobs.schedule |
| SUM-03 | 摘要 | 按项目和会话分组 | live | summaries | — |
| SUM-04 | 摘要 | 摘要质量与原文对照 | live | summary-quality | review.summary |
| TSK-01 | 项目与任务 | 项目列表 | live | projects | — |
| TSK-02 | 项目与任务 | 任务与来源分支 | live | task-branches | — |
| TSK-03 | 项目与任务 | 项目上下文预览 | live | project-context | — |
| TSK-04 | 项目与任务 | 检查点与权威任务状态 | live | task-checkpoints | — |
| TSK-05 | 项目与任务 | 新建项目与任务 | live | task-workflow-preview | projects.bootstrap_preview, projects.bootstrap_confirm, tasks.bootstrap_preview, tasks.bootstrap_confirm |
| TSK-06 | 项目与任务 | 任务对账 | live | task-reconciliation, task-workflow-preview | tasks.reconciliation_preview, tasks.reconciliation_resolve |
| TSK-07 | 项目与任务 | 接续预览 | live | resume-targets, task-branches, resume-status | resume.preview |
| TSK-08 | 项目与任务 | 确认接续 | live | resume-status, resume-history | resume.confirm |
| TSK-09 | 项目与任务 | 投递与完成回执 | live | resume-status, resume-history | — |
| TSK-10 | 项目与任务 | 接续历史 | live | resume-history | — |
| JOB-01 | 整理任务 | 任务队列与执行状态 | live | jobs, job | — |
| JOB-02 | 整理任务 | 创建与定期计划 | live | — | jobs.schedule |
| JOB-03 | 整理任务 | 取消与重试 | live | — | jobs.cancel, jobs.retry |
| JOB-04 | 整理能力 | 能力开关与依赖 | live | system-health, models | features.save |
| JOB-05 | 整理能力 | 补处理历史记忆 | live | system-health | processing.preview, processing.start, processing.pause, processing.resume, processing.cancel |
| JOB-06 | 整理能力 | 新记录自动规则 | live | system-health | schedule.save |
| CON-01 | 连接管理 | 插件连接与应用授权 | live | connections | oauth.revoke |
| CON-02 | 连接管理 | 个人连接 | live | connections | connections.create, connections.update, connections.rotate, connections.disable, connections.enable, connections.revoke |
| CON-03 | ChatGPT | ChatGPT 能读写什么 | live | system-health | features.save |
| AGT-01 | 编程助手 | Agent 实例与设备 | live | connections | devices.revoke |
| AGT-02 | 编程助手 | 捕获健康度 | live | capture-status | — |
| AGT-03 | 编程助手 | 登记与轮换 Agent 密钥 | live | — | devices.register, devices.rotate |
| AGT-04 | 编程助手 | 从助手收什么 | live | system-health | features.save |
| MOD-01 | 模型配置 | 整理模型与向量模型 | live | models | models.save, models.disable |
| MOD-02 | 模型配置 | 连通性测试 | live | — | models.test |
| MOD-03 | 模型配置 | 个人向量索引（含首次建立：冻结清单、总预算、手动启用与回滚） | live | — | vector.schedule, vector.prepare, vector.activate, vector.deactivate |
| MOD-04 | 模型配置 | 用量与预算（含手动调用次数限制） | live | model-usage | models.quota |
| SEC-01 | 账户安全 | 修改密码 | live | — | security.password |
| SEC-02 | 账户安全 | 更换验证器 | live | — | security.totp.begin, security.totp.complete |
| SEC-03 | 账户安全 | 轮换恢复码 | live | — | security.recovery_codes |
| SEC-04 | 账户安全 | 会话管理 | live | security | security.session.revoke, security.sessions.revoke_others |
| SEC-05 | 账户安全 | 登录记录 | live | login-history | — |
| AUD-01 | 审计记录 | 账户事件时间线 | live | audit | — |
| AUD-02 | 审计记录 | 筛选与导出 | live | audit | — |
| USE-01 | 模型与额度 | 调用历史 | live | model-usage | — |
| USE-02 | 模型与额度 | 额度消耗 | live | model-usage | — |
| STO-01 | 存储与备份 | 个人数据导出 | live | export | storage.export |
| STO-02 | 存储与备份 | 导入为新记忆 | live | — | storage.import |
| STO-03 | 存储与备份 | 存储用量 | live | storage | — |
| STO-04 | 存储与备份 | 整库备份与恢复 | policy | — | — |
| STO-05 | 健康 | 平台开关 | live | capabilities | — |
| STO-06 | 健康 | 服务健康 | live | system-health | — |
| STO-07 | 健康 | 版本与迁移 | live | system-version | — |
| STO-08 | 健康 | 备份状态 | live | backups | — |

### 审计来源、引用与导出边界（AUD-01 / AUD-02）

- `GET /console-api/audit?source=core|identity` 每次只返回一个来源，省略 `source` 时为 Core。`entries`、`offset`、`limit`、`next_offset` 全部属于所选来源；不再提供混合的 `core_entries`。界面切换来源保留各自页码，提交筛选重置两者页码。操作名及结果为精确匹配，时间筛选发送规范 UTC 时间；界面输入、显示使用浏览器本地时区。
- Core 记录中的 `credential_id` 是当时留下的凭据引用；可查到的名称、Agent、设备及实例 ID 是凭据签发信息。实例等稳定 ID 保留完整值。当前的撤销状态、当前连接名称/状态与当前记忆标题清楚区分，不推测旧记录缺失的执行者、连接或查询结果。
- 连接映射必须由当前账户的凭据绑定表精确匹配；个人连接包括凭据版本及现已撤销的版本。系统连接只通过当前账户的明确绑定识别。旧绑定已丢失时显示未知/未映射，不通过名称或时间猜测。
- 记忆标题在读取审计页时，仅从本账户当前可读、项目生命周期未删除的记忆解析，最多 500 条/页。正文不随审计接口返回。外账户、已删除项目、缺失的记忆引用保留事件所录 ID，不提供标题或可点击链接。标题不足可能是本页查询上限，不声称内容已被删除。
- 新的 `memory.query` 最多记录 20 个词法子查询返回的 ID，明确标记 `result_refs_kind=lexical_subquery` 与截断。一次 hybrid/semantic 检索可能调用多个词法子查询；这些行、数量和 ID 不代表用户发起的搜索次数或最终语义结果。旧记录的 `result_refs=null` 与新记录的空数组有区别。`memory.read` 记录成功读取的目标 ID。
- `mnemuron-own-audit-v2` 导出仅含当前选中的来源与筛选、事件字段白名单、有限凭据签发信息、当前连接元数据、当前可读记忆标题和词法子查询引用，不含正文、原始查询、密钥或私有哈希。导出按独立来源分页，最多 100 页/16 MiB；是有上限的实时列表，不是数据库快照。失败、无效分页、换来源/筛选、登出使未完成导出失效，不下载部分结果。
- 核心与界面回归：`server/test/console-audit.test.mjs`、`services/oauth/test/console-audit-ui.test.mjs`、`services/oauth/test/console-actions.test.mjs` 中 HTTP-AUDIT；独立真实浏览器验收 `scripts/test-console-audit.mjs` 使用一次性双账户 loopback fixture，涵盖详情隔离、两个来源与分页、迟到响应、导出取消和窄屏。
