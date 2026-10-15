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
| 我的空间 | 概览 | `/app/overview` | `OVW` |
| 我的空间 | 记忆库 | `/app/memories` | `MEM` |
| 我的空间 | 分类与摘要 | `/app/summaries` | `SUM` |
| 我的空间 | 项目与任务 | `/app/tasks` | `TSK` |
| 我的空间 | 接续交接 | `/app/resume` | `RES` |
| 我的空间 | 整理任务 | `/app/jobs` | `JOB` |
| 连接与设置 | 连接管理 | `/app/connections` | `CON` |
| 连接与设置 | 模型配置 | `/app/models` | `MOD` |
| 连接与设置 | 账户安全 | `/app/security` | `SEC` |
| 连接与设置 | 审计记录 | `/app/audit` | `AUD` |
| 连接与设置 | 存储与备份 | `/app/storage` | `STO` |
| 平台管理 | 系统状态 | `/app/system` | `SYS` |

「项目与任务」「接续交接」「系统状态」是原型页面：整页由清单生成，每个功能一张卡片，已上线的排在前面。已上线的卡片显示真实数据，也可以带真实操作；规划中的卡片显示线框和开发说明，不带任何操作。其他页面保留原有的真实功能，并在底部用「功能规划」列出本页规划中和不开放的功能。

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

### 8.1 对象与别名（MEM-08）

- 保存/修订只排入本地队列；后台提取复用账户模型的同意、敏感级别与额度，每次最多 10 条来源。搜索只读已存关系，不调用模型；升级不会给历史记忆补建提取意图。
- 自动接受只支持完整原文中的严格等同声明，且名称限为单个工程标识或连续中文名称。多词名称、引述、条件、否定、附加句子、供应商与主机关系均保守留待确认；模型置信度不代替原文证明。
- 记忆详情中的对象区与记忆库的待确认卡片使用独立、授权的 `entities` 读取；卡片支持独立分页和刷新，晚到的旧分页/刷新结果不能替换新结果。
- 同名对象保持独立。优先显示来源、完整范围、项目/任务/会话上下文、日期与修订；内部 ID 只作辅助。没有项目不等于用户范围，只有实际 `user` 范围才标注为用户范围。
- 锚点正文须同时满足服务端 `current`、活跃状态和完全相同的当前修订；陈旧或不活跃的候选不能确认。拒绝、纠正、停用和解除关联均保留服务端决策边界，不改写记忆正文。
- 手动名称最多 80 个 Unicode 字符。确认对话框明确列出具体名称与来源；手机上完整换行。对象之间的同一对象关联会停用两个对象的手动别名，不在对象之间搬动手动名称；有证明的名称仍依赖原始证明与桥接，解除后扩展失效。相关关系不作为别名搜索扩展。
- 详情关闭、返回、较新的详情读取、退出登录均使旧回复失效。结果到达后焦点进入状态提示，确认标题不能被粘性标题栏遮住；关闭时恢复可用的原触发点。
- 搜索分别标明原始查询完整匹配、原始词匹配和已确认别名匹配；同时显示歧义与截断。混合检索的 top-20 候选再筛选窗口仍如实保留，不把别名扩展描述为解决所有空结果的办法。
- 回归入口：`services/oauth/test/console-entities-ui.test.mjs`、`server/test/entity-alias.test.mjs`、`scripts/test-console-entities.mjs`。浏览器套件只使用一次性合成账户和本地服务，不调用真实模型。

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

本轮按既有清单实现独立的记忆、连接、用量、隐私及系统查看功能，不启用 handoff、不改变其 Hook、确认或回执协议。`production_ready` 继续为 `false`。

### 接口与数据

- 新增只读视图：`attention`、`capture-status`、`model-usage`、`taxonomy`、`privacy-defaults`、`retention`、`memory-versions`、`task-branches`、`project-context`、`task-checkpoints`、`task-reconciliation`、`system-health`、`system-version`、`backups`；身份服务另提供 `login-history`。查询只接受固定参数，不接受前端 `user_id`。
- 新增操作：`memory.batch_classify`、`memory.batch_retract`、`taxonomy.save`、`privacy.defaults`、`retention.save`、`retention.prune`、`devices.register`、`devices.rotate`。沿用完整 console 写权限和功能开关，不扩展 basic credential、OAuth 或 MCP 的能力。
- 新增 `console_preferences`，主键为 `(user_id, kind)`；只存分类、隐私、保留偏好及其版本。启动时幂等建表，不改写既有身份、记忆、来源、生命周期或 OAuth 数据。已有数据库可重复初始化；回退代码时保留此表，不执行破坏性 down migration。
- 偏好变更要求 `expected_revision`。分类使用独立的账户版本；旧排队/运行中的整理任务被隔离并取消发布资格，旧摘要标记过期。旧分类任务不能通过重试绕过新版本，应重新调度。
- 批量操作每次 1～50 条，不允许重复 ID，逐条检查 owner 和已确认 revision；成功和失败分别返回，重放操作 ID 不重复修改，撤回不做物理删除。
- `memory-versions` 的正文分页按 Unicode code points，返回 `content_complete` 和 `next_request`。对比选择器列出最近 100 个版本，双栏读取选中版本完整正文并标记变化区域；超过读取上限时明确失败，不宣称完整。修订记忆可与被替代的上一条记录比较。
- 审计按 `action/outcome` 精确过滤及 UTC `from/to` 时间筛选，两侧数据库执行相同验证。导出只包含当前账户审计元数据，最多 100 页/16 MiB，不是数据库一致性快照，也不包含记忆正文或密钥。

### 隐私和权限

- 隐私默认值只作用于以后在控制台新建的记忆；默认敏感级别可配置。启用该偏好后，新记录明确保持私有，即使账户开启全量云端读取也不能绕过；云端可见性仍须单独逐版本授权。
- 保留设置只改变本账户未来捕获事件的默认值，已有事件的到期时间不变；显式事件级保留值仍遵守现有合同。记忆、检查点、权威任务状态不自动删除。
- 清理需要用户确认、当前密码及未复用的 TOTP；只清理本人已到期且没有固定来源 pin 的原始事件正文，保留元数据和来源链。默认每次 100 条，接口上限 1000；多批须逐次确认。不写全局运维状态，不清他人数据。
- Agent 密钥登记/轮换要求重新验证；最多授予 `memory:read` 或加上 `memory:write/capture:write`，不授予管理、Resume 或任务切换。复用 Core 的加密操作回执和撤销机制；本轮新操作的密钥响应仅原登录会话可在 5 分钟内重试恢复，不接受前端提供会话绑定。平台管理凭证不能在这里轮换。
- 系统视图仅管理员可查看，BFF 在异步请求前后复核权限；平台管理员仍不能查看他人记忆。登录历史包括登录和敏感操作的重新验证；未知用户名及旧版未采集事件不伪造为当前账户记录。

### 未完成及环境边界

- `RES-01～04` 继续延后；`TSK-05` 的 bootstrap 确认及 `TSK-06` 的协调写操作依赖现有 handoff 门禁，因此不绕过门禁开放。任务、项目、检查点和协调提案只能查看。
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

### 记忆整理（分类、筛选整理与撤销）

- **一个整理流程**：选择（当前页勾选最多 100 条，可跨页保留；或“当前筛选的全部有效记忆”）→ 选择或新建分类 → 预览 → 确认 → 结果与撤销。单条“移到分类”、批量整理、删除分类时的成员移动都走同一个写入路径（`server/lib/console/organize.mjs`），每次写入记录为一个整理批次。
- **读取**：沿用 `memories` 视图，不新增入口路径（ingress 不变）。`part=facets` 返回分类计数（含 0）、主题、来源（导入/其他）、导入日期和最近整理；`part=preview&target=<分类>` 加上 `memory_ids` 或筛选（`query`、`category`、`topic`、`origin`、`all=true`）返回将要变化的数量、已在该分类的数量、按当前分类的分布、示例和 `preview_token`。列表新增 `topic`、`origin` 筛选，行内返回主题、是否导入和原始时间。
- **写入**：`memory.organize` 必须携带预览返回的 `preview_token`；服务端在同一事务内重新解析选择，任何变化都返回 `PREVIEW_CHANGED`，不部分写入。一次最多 2000 条；检索候选窗口（500 条）被截断时返回 `SELECTION_TRUNCATED`。`memory.organize_undo` 只恢复此后未再改动的记忆，其余列为 `CHANGED_SINCE`；全部都已改动时返回 `UNDO_CONFLICT` 且批次保持可撤销。同一操作 ID 重放返回同一结果。
- **分类**：ID 稳定，名称可改。`category.create`（名称 1–40 字符，可用中文，ID 自动生成）、`category.rename`（只改名称，不改分类体系版本，不暂停任务，不使摘要过期）、`category.delete`（必须指定 `move_to`，手动分类与模型分类一并移动，可撤销并恢复原分类）。均需 `expected_revision`，并发修改返回 `SETTINGS_VERSION_CHANGED`。分类体系版本变化时，模型分类结果按 ID 复制到新版本（旧行保留，不改写）；指向已不存在分类的结果回落为未分类。`taxonomy.save` 保留为高级入口，同样复制模型分类。
- **上限与重新整理**：预览返回准确的 `total`（全部匹配数）和 `limit`；超过上限时只显示总数、上限和下一步（缩小筛选或逐条勾选），确认按钮明确禁用。分类变更会暂停按旧分类排队的模型任务（`STALE_TAXONOMY`）；对这类任务执行 `jobs.retry` 会在同一事务内按当前分类重新安排同类任务，并把旧任务标记为已接替（`cancelled` + `RESCHEDULED`，不再可重试），已有分类结果和手动分类保留。任务页翻译状态与原因。
- **边界**：手动分类是本地元数据，任何有效记忆都可以设置（包括 secret 和来源已过期的记录）；模型输入规则不变，secret 仍不会发送给模型。整理不修改记忆内容、修订、来源、敏感级别、ChatGPT 授权或 keep_private 拒绝；修订一条记忆时，手动分类随替代记录保留。不物理删除任何记忆。新增动作与 `memory.classify` 同属 memory 组（需要 `memory:organize`），不扩展凭据、scope 或 OAuth/MCP 权限。
- **数据库**：仅新增 `console_organize_batches`、`console_organize_items`、`console_import_records`（`CREATE TABLE IF NOT EXISTS`），不新增迁移步骤，`PRAGMA user_version` 保持 7。旧版本打开同一数据库时忽略这些表，自定义分类显示为 ID。

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
| MEM-05 | 记忆库 | 分类与敏感级别 | live | — | memory.classify, memory.sensitivity |
| MEM-06 | 记忆库 | 批量整理 | live | memories | memory.organize, memory.organize_undo, memory.batch_classify, memory.batch_retract |
| MEM-07 | 记忆库 | 版本对比 | live | memory-versions | — |
| MEM-08 | 记忆库 | 对象关联、别名与候选审阅 | live | entities | entity.create, entity.alias, entity.alias_correct, entity.alias_remove, entity.link, entity.unlink, entity.resolve |
| SUM-01 | 分类与摘要 | 分类索引与派生摘要 | live | summaries, summary | — |
| SUM-02 | 分类与摘要 | 生成分类与摘要 | live | — | jobs.schedule |
| SUM-03 | 分类与摘要 | 自定义分类体系 | live | taxonomy | category.create, category.rename, category.delete, taxonomy.save |
| TSK-01 | 项目与任务 | 项目列表 | live | projects | — |
| TSK-02 | 项目与任务 | 任务与来源分支 | live | task-branches | — |
| TSK-03 | 项目与任务 | 项目上下文预览 | live | project-context | — |
| TSK-04 | 项目与任务 | 检查点与权威任务状态 | live | task-checkpoints | — |
| TSK-05 | 项目与任务 | 新建项目与任务 | planned | — | projects.bootstrap, tasks.bootstrap |
| TSK-06 | 项目与任务 | 任务对账 | planned | task-reconciliation | tasks.reconcile |
| RES-01 | 接续交接 | 接续预览 | planned | resume-preview | — |
| RES-02 | 接续交接 | 确认接续 | planned | — | resume.confirm |
| RES-03 | 接续交接 | 投递与完成回执 | planned | resume-deliveries | — |
| RES-04 | 接续交接 | 接续历史 | planned | resume-history | — |
| JOB-01 | 整理任务 | 任务队列与执行状态 | live | jobs, job | — |
| JOB-02 | 整理任务 | 创建与定期计划 | live | — | jobs.schedule |
| JOB-03 | 整理任务 | 取消与重试 | live | — | jobs.cancel, jobs.retry |
| CON-01 | 连接管理 | 插件连接与应用授权 | live | connections | oauth.revoke |
| CON-02 | 连接管理 | 个人连接 | live | connections | connections.create, connections.update, connections.rotate, connections.disable, connections.enable, connections.revoke |
| CON-03 | 连接管理 | Agent 实例与设备 | live | connections | devices.revoke |
| CON-04 | 连接管理 | 捕获健康度 | live | capture-status | — |
| CON-05 | 连接管理 | 登记与轮换 Agent 密钥 | live | — | devices.register, devices.rotate |
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
| STO-01 | 存储与备份 | 个人数据导出 | live | export | storage.export |
| STO-02 | 存储与备份 | 导入为新记忆 | live | — | storage.import |
| STO-03 | 存储与备份 | 存储用量 | live | storage | — |
| STO-04 | 存储与备份 | 整库备份与恢复 | policy | — | — |
| SYS-01 | 系统状态 | 平台开关 | live | capabilities | — |
| SYS-02 | 系统状态 | 服务健康 | live | system-health | — |
| SYS-03 | 系统状态 | 版本与迁移 | live | system-version | — |
| SYS-04 | 系统状态 | 备份状态 | live | backups | — |

### 审计来源、引用与导出边界（AUD-01 / AUD-02）

- `GET /console-api/audit?source=core|identity` 每次只返回一个来源，省略 `source` 时为 Core。`entries`、`offset`、`limit`、`next_offset` 全部属于所选来源；不再提供混合的 `core_entries`。界面切换来源保留各自页码，提交筛选重置两者页码。操作名及结果为精确匹配，时间筛选发送规范 UTC 时间；界面输入、显示使用浏览器本地时区。
- Core 记录中的 `credential_id` 是当时留下的凭据引用；可查到的名称、Agent、设备及实例 ID 是凭据签发信息。实例等稳定 ID 保留完整值。当前的撤销状态、当前连接名称/状态与当前记忆标题清楚区分，不推测旧记录缺失的执行者、连接或查询结果。
- 连接映射必须由当前账户的凭据绑定表精确匹配；个人连接包括凭据版本及现已撤销的版本。系统连接只通过当前账户的明确绑定识别。旧绑定已丢失时显示未知/未映射，不通过名称或时间猜测。
- 记忆标题在读取审计页时，仅从本账户当前可读、项目生命周期未删除的记忆解析，最多 500 条/页。正文不随审计接口返回。外账户、已删除项目、缺失的记忆引用保留事件所录 ID，不提供标题或可点击链接。标题不足可能是本页查询上限，不声称内容已被删除。
- 新的 `memory.query` 最多记录 20 个词法子查询返回的 ID，明确标记 `result_refs_kind=lexical_subquery` 与截断。一次 hybrid/semantic 检索可能调用多个词法子查询；这些行、数量和 ID 不代表用户发起的搜索次数或最终语义结果。旧记录的 `result_refs=null` 与新记录的空数组有区别。`memory.read` 记录成功读取的目标 ID。
- `mnemuron-own-audit-v2` 导出仅含当前选中的来源与筛选、事件字段白名单、有限凭据签发信息、当前连接元数据、当前可读记忆标题和词法子查询引用，不含正文、原始查询、密钥或私有哈希。导出按独立来源分页，最多 100 页/16 MiB；是有上限的实时列表，不是数据库快照。失败、无效分页、换来源/筛选、登出使未完成导出失效，不下载部分结果。
- 核心与界面回归：`server/test/console-audit.test.mjs`、`services/oauth/test/console-audit-ui.test.mjs`、`services/oauth/test/console-actions.test.mjs` 中 HTTP-AUDIT；独立真实浏览器验收 `scripts/test-console-audit.mjs` 使用一次性双账户 loopback fixture，涵盖详情隔离、两个来源与分页、迟到响应、导出取消和窄屏。
