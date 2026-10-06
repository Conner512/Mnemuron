# Console release feature matrix

This matrix describes the candidate source, not deployment or host certification.
It reconciles `web/console/visuals.mjs` with the feature standard. The inherited
working copy already implements 18 of the historical 24 planned entries; those
changes are retained, not claimed as newly authored in this release review.

Current inventory: **63 entries: 54 live, 6 planned, 3 policy exclusions**.

Browser suites: `functional` = `scripts/test-console-browser.py`; `completion` =
`scripts/test-console-completion.mjs`; `models` = `scripts/test-console-models.mjs`;
`connections` = `scripts/test-console-connections.mjs`. All use disposable synthetic
Core/OAuth accounts and loopback HTTP. The model and vector fixtures do not certify
an external provider or real Qdrant. API tests include negative authorization;
render/contract tests alone are not functional acceptance.

| ID | Feature | Source status | API / contract regression files | Browser coverage |
| --- | --- | --- | --- | --- |
| OVW-01 | 记忆分布与计数 | live | `server/test/console-completion.test.mjs` | completion |
| OVW-02 | 最近写入与 30 天活动 | live | `server/test/console-completion.test.mjs` | completion |
| OVW-03 | 待处理事项 | live | `server/test/console-completion.test.mjs` | completion |
| MEM-01 | 检索与筛选 | live | `server/test/console-completion.test.mjs`; `server/test/cloud-memory-privacy.test.mjs`; `services/oauth/test/console-memory-selection.test.mjs` | functional + completion |
| MEM-02 | 详情、来源与修订历史 | live | `server/test/console-completion.test.mjs`; `server/test/cloud-memory-privacy.test.mjs`; `services/oauth/test/console-memory-selection.test.mjs` | functional + completion |
| MEM-03 | 新建记忆 | live | `server/test/console-completion.test.mjs`; `server/test/cloud-memory-privacy.test.mjs`; `services/oauth/test/console-memory-selection.test.mjs` | functional + completion |
| MEM-04 | 修订与撤回 | live | `server/test/console-completion.test.mjs`; `server/test/cloud-memory-privacy.test.mjs`; `services/oauth/test/console-memory-selection.test.mjs` | functional + completion |
| MEM-05 | 分类、敏感级别与 ChatGPT 可见性 | live | `server/test/console-completion.test.mjs`; `server/test/cloud-memory-privacy.test.mjs`; `services/oauth/test/console-memory-selection.test.mjs` | functional + completion |
| MEM-06 | 批量整理 | live | `server/test/console-completion.test.mjs`; `server/test/cloud-memory-privacy.test.mjs`; `services/oauth/test/console-memory-selection.test.mjs` | functional + completion |
| MEM-07 | 版本对比 | live | `server/test/console-completion.test.mjs`; `server/test/cloud-memory-privacy.test.mjs`; `services/oauth/test/console-memory-selection.test.mjs` | functional + completion |
| SUM-01 | 分类索引与派生摘要 | live | `server/test/console-model-pipeline.test.mjs`; `server/test/console-completion.test.mjs` | functional + models |
| SUM-02 | 生成分类与摘要 | live | `server/test/console-model-pipeline.test.mjs`; `server/test/console-completion.test.mjs` | functional + models |
| SUM-03 | 自定义分类体系 | live | `server/test/console-model-pipeline.test.mjs`; `server/test/console-completion.test.mjs` | functional + models |
| TSK-01 | 项目列表 | live | `server/test/console-completion.test.mjs`; `services/oauth/test/console-feature-map.test.mjs` | completion (reads only) |
| TSK-02 | 任务与来源分支 | live | `server/test/console-completion.test.mjs`; `services/oauth/test/console-feature-map.test.mjs` | completion (reads only) |
| TSK-03 | 项目上下文预览 | live | `server/test/console-completion.test.mjs`; `services/oauth/test/console-feature-map.test.mjs` | completion (reads only) |
| TSK-04 | 检查点与权威任务状态 | live | `server/test/console-completion.test.mjs`; `services/oauth/test/console-feature-map.test.mjs` | completion (reads only) |
| TSK-05 | 新建项目与任务 | planned | `services/oauth/test/console-feature-map.test.mjs` | disabled / policy rendering; no successful operation claimed |
| TSK-06 | 任务对账 | planned | `services/oauth/test/console-feature-map.test.mjs` | disabled / policy rendering; no successful operation claimed |
| RES-01 | 接续预览 | planned | `services/oauth/test/console-feature-map.test.mjs` | disabled / policy rendering; no successful operation claimed |
| RES-02 | 确认接续 | planned | `services/oauth/test/console-feature-map.test.mjs` | disabled / policy rendering; no successful operation claimed |
| RES-03 | 投递与完成回执 | planned | `services/oauth/test/console-feature-map.test.mjs` | disabled / policy rendering; no successful operation claimed |
| RES-04 | 接续历史 | planned | `services/oauth/test/console-feature-map.test.mjs` | disabled / policy rendering; no successful operation claimed |
| JOB-01 | 任务队列与执行状态 | live | `server/test/console-model-pipeline.test.mjs`; `server/test/memory-first-jobs.test.mjs` | functional + models |
| JOB-02 | 创建与定期计划 | live | `server/test/console-model-pipeline.test.mjs`; `server/test/memory-first-jobs.test.mjs` | functional + models |
| JOB-03 | 取消与重试 | live | `server/test/console-model-pipeline.test.mjs`; `server/test/memory-first-jobs.test.mjs` | functional + models |
| CON-01 | 插件连接与应用授权 | live | `services/oauth/test/connections.test.mjs`; `adapters/chatgpt-web/test/connections.test.mjs`; `server/test/console-completion.test.mjs` | connections + completion |
| CON-02 | 个人连接 | live | `services/oauth/test/connections.test.mjs`; `adapters/chatgpt-web/test/connections.test.mjs`; `server/test/console-completion.test.mjs` | connections + completion |
| CON-03 | Agent 实例与设备 | live | `services/oauth/test/connections.test.mjs`; `adapters/chatgpt-web/test/connections.test.mjs`; `server/test/console-completion.test.mjs` | connections + completion |
| CON-04 | 捕获健康度 | live | `services/oauth/test/connections.test.mjs`; `adapters/chatgpt-web/test/connections.test.mjs`; `server/test/console-completion.test.mjs` | connections + completion |
| CON-05 | 登记与轮换 Agent 密钥 | live | `services/oauth/test/connections.test.mjs`; `adapters/chatgpt-web/test/connections.test.mjs`; `server/test/console-completion.test.mjs` | connections + completion |
| MOD-01 | 整理模型与向量模型 | live | `server/test/console-model-pipeline.test.mjs`; `services/oauth/test/console-models-ui.test.mjs` | models |
| MOD-02 | 连通性测试 | live | `server/test/console-model-pipeline.test.mjs`; `services/oauth/test/console-models-ui.test.mjs` | models |
| MOD-03 | 个人向量索引 | live | `server/test/console-model-pipeline.test.mjs`; `services/oauth/test/console-models-ui.test.mjs` | models |
| MOD-04 | 用量与预算 | live | `server/test/console-model-pipeline.test.mjs`; `services/oauth/test/console-models-ui.test.mjs` | models |
| PRV-01 | 外发许可总览 | live | `server/test/cloud-memory-privacy.test.mjs`; `server/test/console-completion.test.mjs` | completion |
| PRV-02 | 新记忆默认设置 | live | `server/test/cloud-memory-privacy.test.mjs`; `server/test/console-completion.test.mjs` | completion |
| PRV-03 | 数据保留策略 | live | `server/test/cloud-memory-privacy.test.mjs`; `server/test/console-completion.test.mjs` | completion |
| PRV-04 | 清理过期数据 | live | `server/test/cloud-memory-privacy.test.mjs`; `server/test/console-completion.test.mjs` | completion |
| PRV-05 | 删除账户与全部数据 | policy | `services/oauth/test/console-feature-map.test.mjs` | disabled / policy rendering; no successful operation claimed |
| PRV-06 | ChatGPT 读取范围 | live | `server/test/cloud-memory-privacy.test.mjs`; `server/test/console-completion.test.mjs` | completion |
| SEC-01 | 修改密码 | live | `services/oauth/test/recovery.test.mjs`; `services/oauth/test/identity-repository.test.mjs`; `services/oauth/test/console-actions.test.mjs` | functional + completion |
| SEC-02 | 更换验证器 | live | `services/oauth/test/recovery.test.mjs`; `services/oauth/test/identity-repository.test.mjs`; `services/oauth/test/console-actions.test.mjs` | functional + completion |
| SEC-03 | 轮换恢复码 | live | `services/oauth/test/recovery.test.mjs`; `services/oauth/test/identity-repository.test.mjs`; `services/oauth/test/console-actions.test.mjs` | functional + completion |
| SEC-04 | 会话管理 | live | `services/oauth/test/recovery.test.mjs`; `services/oauth/test/identity-repository.test.mjs`; `services/oauth/test/console-actions.test.mjs` | functional + completion |
| SEC-05 | 登录记录 | live | `services/oauth/test/recovery.test.mjs`; `services/oauth/test/identity-repository.test.mjs`; `services/oauth/test/console-actions.test.mjs` | functional + completion |
| AUD-01 | 账户事件时间线 | live | `services/oauth/test/console-reads.test.mjs`; `services/oauth/test/console-actions.test.mjs` | completion |
| AUD-02 | 筛选与导出 | live | `services/oauth/test/console-reads.test.mjs`; `services/oauth/test/console-actions.test.mjs` | completion |
| STO-01 | 个人数据导出 | live | `server/test/console-actions.test.mjs`; `services/oauth/test/release-upgrade.test.mjs` | functional |
| STO-02 | 导入为新记忆 | live | `server/test/console-actions.test.mjs`; `services/oauth/test/release-upgrade.test.mjs` | functional |
| STO-03 | 存储用量 | live | `server/test/console-actions.test.mjs`; `services/oauth/test/release-upgrade.test.mjs` | functional |
| STO-04 | 整库备份与恢复 | policy | `services/oauth/test/console-feature-map.test.mjs` | disabled / policy rendering; no successful operation claimed |
| INV-01 | 注册码清单 | live | `services/oauth/test/identity-repository.test.mjs`; `services/oauth/test/registration-console.test.mjs` | functional |
| INV-02 | 批量签发 | live | `services/oauth/test/identity-repository.test.mjs`; `services/oauth/test/registration-console.test.mjs` | functional |
| INV-03 | 撤销 | live | `services/oauth/test/identity-repository.test.mjs`; `services/oauth/test/registration-console.test.mjs` | functional |
| ACC-01 | 账户清单 | live | `services/oauth/test/identity-boundaries.test.mjs`; `services/oauth/test/console-actions.test.mjs` | functional + completion |
| ACC-02 | 停用与启用 | live | `services/oauth/test/identity-boundaries.test.mjs`; `services/oauth/test/console-actions.test.mjs` | functional + completion |
| ACC-03 | 平台管理员角色 | live | `services/oauth/test/identity-boundaries.test.mjs`; `services/oauth/test/console-actions.test.mjs` | functional + completion |
| ACC-04 | 查看他人记忆 | policy | `services/oauth/test/console-feature-map.test.mjs` | disabled / policy rendering; no successful operation claimed |
| SYS-01 | 平台开关 | live | `server/test/console-completion.test.mjs`; `services/oauth/test/console-feature-map.test.mjs` | completion |
| SYS-02 | 服务健康 | live | `server/test/console-completion.test.mjs`; `services/oauth/test/console-feature-map.test.mjs` | completion |
| SYS-03 | 版本与迁移 | live | `server/test/console-completion.test.mjs`; `services/oauth/test/console-feature-map.test.mjs` | completion |
| SYS-04 | 备份状态 | live | `server/test/console-completion.test.mjs`; `services/oauth/test/console-feature-map.test.mjs` | completion |

## Remaining functional scope decisions

- **TSK-05**: web project/task bootstrap is not implemented. Core/adapters have
  preview/confirm protocols, but these are not an owner-scoped console workflow.
- **TSK-06**: proposal reads are implemented; browser reconciliation confirmation
  and canonical edits remain unavailable.
- **RES-01..04**: browser Resume preview, confirmation, delivery status and history
  remain planned. A real destination session/agent, exact preview and separate
  confirmation/delivery/ACK are required. Generic MCP and ChatGPT Web are expressly
  memory-only and must not silently gain those capabilities.
- **PRV-05, STO-04, ACC-04** remain deliberate exclusions: account deletion in the
  web UI, whole shared-database backup/restore in the web UI, and reading another
  owner's memories as an operator. Completing the product does not remove these
  boundaries.

The candidate therefore does **not** claim all 63 entries are executable. Opening
additional browser task/handoff workflows requires a reviewed account-scoped
capability design and separate permission for any production credential changes.

## Host acceptance is separate

| Host / path | Local evidence | Real-host evidence needed |
| --- | --- | --- |
| Core + desktop console | HTTP, browser, migration and dual-owner tests | Final release deployment and member account acceptance |
| ChatGPT Web / remote OAuth MCP | PKCE/CSRF/resource scopes, callbacks, replay/revocation and SDK tests | Real ChatGPT OAuth consent plus authorized synthetic memory operations |
| Generic MCP | SDK/scoped finite token tests and connection UI | Selected real client's transport, headers and token lifecycle |
| ChatGPT Work / Codex local plugin | Plugin unit and lifecycle contracts | Capture, preview, exact confirm, next-turn delivery and terminal ACK on each supported device |
| OpenClaw | Adapter suite and isolated failure harness | Installed host/version lifecycle and restart/partition cases |
| Hermes | Python adapter suite | Installed host/version lifecycle and restart/partition cases |

No one host's pass is substituted for another. Freeze the supported host/version
list before public claims; retain the existing seven-day stability gate.
