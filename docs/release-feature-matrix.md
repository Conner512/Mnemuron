# Console release feature matrix

This matrix describes the current candidate source and its validation boundaries.
The inventory matches `web/console/visuals.mjs` and the feature table in
[Console feature standard](console-feature-standard.md): **63 entries: 62 live,
0 planned, 1 policy exclusion**. A `live` entry has an implemented interface;
deployment, enabled runtime capabilities, actual provider behavior and real-host
acceptance remain separate. `production_ready` remains `false`.

Earlier review counts and IDs are historical. The former `RES-01..04` entries now
appear as `TSK-07..10`; former Agent entries `CON-03..05` moved to `AGT-01..03`,
and `SYS-01..04` moved to `STO-05..08`. The current `CON-03` is the ChatGPT access
policy card. Retired `PRV`, `INV` and `ACC` pages are outside this inventory.
`OVW-04` (full-library association UI) is retired; its owner-scoped backend graph reads and
regressions remain for compatibility, but there is no overview search or association entry.
Projects/tasks (`TSK-*`) describe retained authenticated compatibility pages and APIs, not
active navigation. Their entry is hidden while memory and connections take priority; stored
data, existing grants and background jobs are unchanged. See the feature standard for scope.

## Regression and browser entrypoints

Browser aliases in the table refer to these reproducible scripts. The measured
results for this task-workflow change are recorded below the inventory; the
coverage column identifies entrypoints rather than asserting a new run for every
listed suite.

| Alias | Script |
| --- | --- |
| functional | `scripts/test-console-browser.py` |
| completion | `scripts/test-console-completion.mjs` |
| models | `scripts/test-console-models.mjs` |
| connections | `scripts/test-console-connections.mjs` |
| agent-regressions | `scripts/test-console-agent-fixes.mjs` |
| refinements | `scripts/test-console-refinements.mjs` |
| audit | `scripts/test-console-audit.mjs` |
| responsive | `scripts/test-console-responsive.mjs` |
| continuity | `scripts/test-console-workflow-continuity.mjs` |
| task-workflows | `scripts/test-console-task-workflows.mjs` |
| memory-review | `scripts/test-console-memory-review.mjs` |
| selected-processing | `scripts/test-memory-processing-browser.mjs` |
| search-workbench | `scripts/test-console-search-workbench.mjs` |
| operations | `scripts/test-console-operations.mjs` |
| overview-ux | `scripts/test-console-overview-ux.mjs` |
| control-alignment | `scripts/test-console-control-alignment.mjs` |
| summary-reader | `scripts/test-console-summary-reader.mjs` |

These suites use disposable synthetic Core/OAuth accounts and loopback HTTP.
Model and vector fixtures do not certify an external provider or real Qdrant.
API tests include negative authorization; renderer/contract checks alone do not
establish successful browser operations. Responsive checks cover the shared
layout separately from the action coverage shown here.

## Current inventory

| ID | Feature | Source status | API / contract regression files | Browser coverage |
| --- | --- | --- | --- | --- |
| OVW-01 | 记忆分布与计数 | live | `server/test/console-completion.test.mjs` | completion |
| OVW-02 | 最近写入与 30 天活动 | live | `server/test/console-completion.test.mjs` | completion |
| OVW-03 | 待处理事项 | live | `server/test/console-completion.test.mjs` | completion |
| MEM-01 | 检索与筛选 | live | `server/test/console-completion.test.mjs`; `server/test/cloud-memory-privacy.test.mjs`; `services/oauth/test/console-memory-selection.test.mjs` | functional + completion + continuity |
| MEM-02 | 详情、来源与修订历史 | live | `server/test/console-completion.test.mjs`; `server/test/cloud-memory-privacy.test.mjs`; `services/oauth/test/console-memory-selection.test.mjs` | functional + completion |
| MEM-03 | 新建记忆 | live | `server/test/console-completion.test.mjs`; `server/test/cloud-memory-privacy.test.mjs`; `services/oauth/test/console-memory-selection.test.mjs` | functional + completion |
| MEM-04 | 修订与撤回 | live | `server/test/console-completion.test.mjs`; `server/test/cloud-memory-privacy.test.mjs`; `services/oauth/test/console-memory-selection.test.mjs` | functional + completion |
| MEM-05 | 类型 | live | `server/test/memory-traits.test.mjs`; `server/test/console-actions.test.mjs`; `services/oauth/test/console-library-ui.test.mjs` | functional + completion |
| MEM-06 | 批量撤回 | live | `server/test/console-completion.test.mjs`; `services/oauth/test/console-memory-selection.test.mjs` | functional + completion |
| MEM-07 | 版本对比 | live | `server/test/console-completion.test.mjs`; `server/test/cloud-memory-privacy.test.mjs`; `services/oauth/test/console-memory-selection.test.mjs` | functional + completion |
| MEM-08 | 关键词筛选与地图 | live | `server/test/memory-traits.test.mjs`; `server/test/console-memory-graph.test.mjs`; `services/oauth/test/console-library-ui.test.mjs` | functional |
| MEM-09 | 候选审核工作台 | live | `server/test/console-memory-review.test.mjs`; `services/oauth/test/console-actions.test.mjs` | memory-review |
| MEM-10 | 记忆对照与人工复查 | live | `server/test/console-memory-review.test.mjs`; `services/oauth/test/console-actions.test.mjs` | memory-review |
| MEM-11 | 处理证据与选中补处理 | live | `server/test/memory-processing-workbench.test.mjs`; `services/oauth/test/console-actions.test.mjs`; `services/oauth/test/console-memory-processing.test.mjs` | `scripts/test-memory-processing-browser.mjs`: exact selection, explicit confirmation, completed evidence, basic grant and mobile layout |
| MEM-12 | 搜索反馈与验收 | live | `server/test/console-search-feedback.test.mjs`; `server/test/search-workbench-quality.test.mjs`; `services/oauth/test/console-actions.test.mjs` | search-workbench |
| SUM-01 | 摘要列表 | live | `server/test/console-model-pipeline.test.mjs`; `server/test/console-completion.test.mjs` | functional + models + refinements (summaries) |
| SUM-02 | 生成摘要 | live | `server/test/console-model-pipeline.test.mjs`; `server/test/console-completion.test.mjs` | functional + models |
| SUM-03 | 按项目和会话分组 | live | `server/test/memory-first-jobs.test.mjs`; `services/oauth/test/console-library-ui.test.mjs` | models + refinements (summaries) |
| SUM-04 | 摘要质量与原文对照 | live | `server/test/console-memory-review.test.mjs`; `services/oauth/test/console-actions.test.mjs` | memory-review |
| TSK-01 | 项目列表 | live | `server/test/console-projects.test.mjs`; `server/test/project-lifecycle-mutations.test.mjs`; `services/oauth/test/console-feature-map.test.mjs` | completion + refinements (projects, lifecycle) |
| TSK-02 | 任务与来源分支 | live | `server/test/console-projects.test.mjs`; `server/test/console-completion.test.mjs`; `services/oauth/test/console-feature-map.test.mjs` | completion + refinements (projects) + task-workflows (exact selected task) |
| TSK-03 | 项目上下文预览 | live | `server/test/console-completion.test.mjs`; `services/oauth/test/console-feature-map.test.mjs` | completion (reads only) |
| TSK-04 | 检查点与权威任务状态 | live | `server/test/console-completion.test.mjs`; `services/oauth/test/console-feature-map.test.mjs` | completion (reads only) |
| TSK-05 | 新建项目与任务 | live | `server/test/console-task-workflows.test.mjs`; `services/oauth/test/console-actions.test.mjs`; `services/oauth/test/console-task-workflows-ui.test.mjs` | task-workflows: frozen creation, fresh factors, lost-response retry, expiry and refresh failure |
| TSK-06 | 任务对账 | live | `server/test/console-task-workflows.test.mjs`; `services/oauth/test/console-actions.test.mjs`; `services/oauth/test/console-task-workflows-ui.test.mjs` | task-workflows: no-effect review and whole-proposal accept/reject with real canonical revisions |
| TSK-07 | 接续预览 | live | `server/test/console-resume-workflows.test.mjs`; `services/oauth/test/console-task-workflows-ui.test.mjs` | task-workflows: observed target, explicit source subset, source-read recovery and revoked target |
| TSK-08 | 确认接续 | live | `server/test/console-resume-workflows.test.mjs`; `services/oauth/test/console-actions.test.mjs`; `services/oauth/test/console-task-workflows-ui.test.mjs` | task-workflows: exact preview/version, queued result, explicit cancellation and session revocation |
| TSK-09 | 投递与完成回执 | live | `server/test/console-resume-workflows.test.mjs`; `server/test/console-hermes-workflow.test.mjs`; `services/oauth/test/console-task-workflows-ui.test.mjs` | task-workflows: real target HTTP pull, separate delivery/completion receipts and mobile detail table |
| TSK-10 | 接续历史 | live | `server/test/console-resume-workflows.test.mjs`; `services/oauth/test/console-task-workflows-ui.test.mjs` | task-workflows: real second page, guarded detail reads and cross-account denial |
| JOB-01 | 任务队列与执行状态 | live | `server/test/console-model-pipeline.test.mjs`; `server/test/memory-first-jobs.test.mjs` | functional + models |
| JOB-02 | 创建与定期计划 | live | `server/test/console-model-pipeline.test.mjs`; `server/test/memory-first-jobs.test.mjs` | functional + models |
| JOB-03 | 取消与重试 | live | `server/test/console-model-pipeline.test.mjs`; `server/test/memory-first-jobs.test.mjs`; `services/oauth/test/console-job-recovery.test.mjs` | functional + models + continuity |
| JOB-04 | 能力开关与依赖 | live | `server/test/owner-controls.test.mjs`; `services/oauth/test/console-owner-pages.test.mjs` | Owner controls have Core and renderer coverage; no browser owner-write pass claimed here |
| JOB-05 | 补处理历史记忆 | live | `server/test/owner-controls.test.mjs`; `server/test/owner-processing-recovery.test.mjs`; `services/oauth/test/console-owner-pages.test.mjs` | Owner controls have Core and renderer coverage; no browser owner-write pass claimed here |
| JOB-06 | 新记录自动规则 | live | `server/test/owner-controls.test.mjs`; `server/test/worker-owner-boundaries.test.mjs`; `services/oauth/test/console-owner-pages.test.mjs` | Owner rules have Core and renderer coverage; no browser rule-edit pass claimed here |
| CON-01 | 插件连接与应用授权 | live | `services/oauth/test/connections.test.mjs`; `adapters/chatgpt-web/test/connections.test.mjs`; `services/oauth/test/agents-connections.test.mjs` | connections + completion + agent-regressions |
| CON-02 | 个人连接 | live | `services/oauth/test/connections.test.mjs`; `services/oauth/test/connections-ui.test.mjs`; `services/oauth/test/agents-connections.test.mjs` | connections + completion + agent-regressions |
| CON-03 | ChatGPT 能读写什么 | live | `server/test/owner-controls.test.mjs`; `services/oauth/test/console-owner-pages.test.mjs` | Owner policy has Core and renderer coverage; no browser owner-policy write pass claimed here |
| AGT-01 | Agent 实例与设备 | live | `services/oauth/test/agents-connections.test.mjs`; `services/oauth/test/connections-ui.test.mjs`; `server/test/console-completion.test.mjs` | connections + completion + agent-regressions |
| AGT-02 | 捕获健康度 | live | `server/test/console-completion.test.mjs`; `services/oauth/test/connections-ui.test.mjs` | completion: server observations, local hook/queue health remains not_observable |
| AGT-03 | 登记与轮换 Agent 密钥 | live | `services/oauth/test/agents-connections.test.mjs`; `services/oauth/test/connections-ui.test.mjs`; `server/test/console-completion.test.mjs` | connections + completion + agent-regressions |
| AGT-04 | 从助手收什么 | live | `server/test/owner-controls.test.mjs`; `services/oauth/test/console-owner-pages.test.mjs` | Owner policy has Core and renderer coverage; no browser capture-policy write pass claimed here |
| MOD-01 | 整理模型与向量模型 | live | `server/test/console-model-pipeline.test.mjs`; `services/oauth/test/console-models-ui.test.mjs` | models |
| MOD-02 | 连通性测试 | live | `server/test/console-model-pipeline.test.mjs`; `services/oauth/test/console-models-ui.test.mjs` | models |
| MOD-03 | 个人向量索引（含首次建立：冻结清单、总预算、手动启用与回滚） | live | `server/test/console-model-pipeline.test.mjs`; `services/oauth/test/console-models-ui.test.mjs` | models |
| MOD-04 | 用量、预算与可选费用估算 | live | `server/test/console-model-pipeline.test.mjs`; `server/test/model-usage-observation.test.mjs`; `services/oauth/test/console-operations-evidence-ui.test.mjs` | models + operations; provider usage and versioned price snapshots are not a billing invoice |
| SEC-01 | 修改密码 | live | `services/oauth/test/recovery.test.mjs`; `services/oauth/test/identity-repository.test.mjs`; `services/oauth/test/console-actions.test.mjs` | functional + completion |
| SEC-02 | 更换验证器 | live | `services/oauth/test/recovery.test.mjs`; `services/oauth/test/identity-repository.test.mjs`; `services/oauth/test/console-actions.test.mjs` | functional + completion |
| SEC-03 | 轮换恢复码 | live | `services/oauth/test/recovery.test.mjs`; `services/oauth/test/identity-repository.test.mjs`; `services/oauth/test/console-actions.test.mjs` | functional + completion |
| SEC-04 | 会话管理 | live | `services/oauth/test/recovery.test.mjs`; `services/oauth/test/identity-repository.test.mjs`; `services/oauth/test/console-actions.test.mjs` | functional + completion |
| SEC-05 | 登录记录 | live | `services/oauth/test/recovery.test.mjs`; `services/oauth/test/identity-repository.test.mjs`; `services/oauth/test/console-actions.test.mjs` | functional + completion |
| AUD-01 | 账户事件时间线 | live | `server/test/console-audit.test.mjs`; `services/oauth/test/console-audit-ui.test.mjs`; `services/oauth/test/console-actions.test.mjs` | audit + completion |
| AUD-02 | 筛选与导出 | live | `server/test/console-audit.test.mjs`; `services/oauth/test/console-audit-ui.test.mjs`; `services/oauth/test/console-actions.test.mjs` | audit: filters, export, races and owner boundaries |
| USE-01 | 调用历史 | live | `server/test/console-usage-history.test.mjs`; `server/test/console-model-quotas.test.mjs` | models (usage and budgets); external billing is unmetered |
| USE-02 | 额度消耗 | live | `server/test/console-usage-history.test.mjs`; `server/test/console-model-quotas.test.mjs` | models (usage and budgets); external billing is unmetered |
| STO-01 | 个人数据导出 | live | `server/test/console-actions.test.mjs`; `services/oauth/test/release-upgrade.test.mjs` | functional |
| STO-02 | 导入为新记忆 | live | `server/test/console-actions.test.mjs`; `services/oauth/test/release-upgrade.test.mjs` | functional |
| STO-03 | 存储用量 | live | `server/test/console-actions.test.mjs`; `services/oauth/test/release-upgrade.test.mjs` | functional |
| STO-04 | 整库备份与恢复 | policy | `services/oauth/test/console-feature-map.test.mjs` | disabled / policy rendering; no successful operation claimed |
| STO-05 | 平台开关 | live | `server/test/console-completion.test.mjs`; `services/oauth/test/console-feature-map.test.mjs` | completion |
| STO-06 | 服务健康 | live | `server/test/console-completion.test.mjs`; `services/oauth/test/console-feature-map.test.mjs` | completion |
| STO-07 | 版本与迁移 | live | `server/test/console-completion.test.mjs`; `services/oauth/test/console-feature-map.test.mjs` | completion |
| STO-08 | 备份状态 | live | `server/test/backup-status-evidence.test.mjs`; `services/oauth/test/console-operations-evidence-ui.test.mjs` | operations; trusted creation, verify and isolated-restore evidence, including later failure |

## Task-workflow acceptance recorded on 2026-10-29

The current local source completed the following isolated runs. Evidence and
screenshots were written outside Git in the private run directory
`task-workflows-browser-eYZLtZ`; its `result.json` records the individual browser
checks. These are local results, not a real-host or production certification.

| Executed validation | Recorded result |
| --- | --- |
| `services/oauth/test/console-task-workflows-ui.test.mjs` | 12/12 passed: real Core writes plus response-loss, invalidation, account/race and bounded-pagination boundaries |
| `services/oauth/test/console-feature-map.test.mjs` | 11/11 passed; combined Node invocation: 23/23 |
| `scripts/test-console-task-workflows.mjs` | 51/51 passed against real loopback Core/OAuth/BFF and Chrome 156.0.8078.73 with Playwright 1.57.0 |
| Browser error and cleanup checks | 0 JavaScript/CSP errors, 0 HTTP 429; fixture cleanup verified and `synthetic_cleanup_verified:true` emitted |
| Language and layout | Chinese/English creation forms and actual receipt details checked at 390px; desktop receipt screenshot also inspected |

The browser run exercises project and task creation through frozen previews,
current-password/TOTP confirmation, response loss without duplicate creation,
post-commit list-refresh failure, preview expiry, no-effect reconciliation,
whole-proposal acceptance/rejection, source-read recovery, observed targets,
explicit source selection, cancellation, history pagination, cross-account
isolation, target revocation and session-revocation cleanup. It drives the actual
Core Agent HTTP protocol through `pending_confirmation → queued → target pull
(still queued) → delivered receipt → paired completion receipt`. It does not run
an installed Codex/OpenClaw/Hermes host or substitute an API receipt for host
acceptance.

The corresponding Core/BFF/adapter regression entrypoints are
`server/test/console-task-workflows.test.mjs`,
`server/test/console-resume-workflows.test.mjs`,
`server/test/console-hermes-workflow.test.mjs`,
`services/oauth/test/console-actions.test.mjs`,
`plugins/mnemuron/test/console-resume.test.mjs`,
`adapters/openclaw/test/console-resume.test.mjs` and
`adapters/hermes/test/test_console_resume.py`. Their separate execution evidence
belongs with the immutable candidate's release run.

## Implemented workflow and retained policy boundaries

- **TSK-05** creates an owner-scoped Console project/task only after an exact,
  credential-bound preview is confirmed. It does not impersonate an external
  Agent session. **TSK-06** accepts or rejects an entire frozen proposal;
  acceptance of individual fields is not implemented or advertised.
- **TSK-07..10** use a server-observed, currently authorized destination session,
  an exact preview/version and separate confirmation, delivery and completion
  evidence. Confirmation queues work; fetching the queue records no delivery.
  Recent receipt windows report their true totals and truncation, while overall
  completion uses the complete receipt record. Content-bounded history pages
  continue from the records actually returned.
- The workflows retain the existing handoff gate and exact Console/Agent
  permission boundaries. A code or synthetic-test pass does not enable handoff,
  upgrade existing credentials, modify production ingress or deploy plugins.
  Generic MCP and ChatGPT Web remain memory-only for these task/handoff paths.
- **STO-04** is the sole current `policy` entry: shared-database backup/restore
  remains an operator maintenance operation outside the web UI. The retired
  `PRV-05` and `ACC-04` exclusions also remain in force: no web account deletion
  and no operator access to another owner's memories. Retired IDs are not counted
  as current feature cards.
- **AGT-02** reports actual server observations; unreported local hook failures
  and queues remain `not_observable`. **STO-08** has a backup-status read interface,
  but absent trusted backup evidence remains `not_configured`, `missing` or `unknown`
  and never establishes backup or restore acceptance. Owner Console providers now
  record reported tokens and per-attempt latency; optional request-time price
  estimates remain distinct from actual external billing. Unsupported standalone
  providers and missing usage remain unobserved/unknown, never free.

## Memory workbench and checkpoint coverage

Issue #6 adds source-bound candidate approval, two-memory manual review, summary
comparison and feedback, exact-selection processing, project/task graph evidence,
explicit search feedback, observed provider usage and trusted backup evidence.
The four additional browser scripts above run in the existing isolated browser CI;
their private fixture databases, credentials and evidence are not uploaded as artifacts.

Oversized source summaries are covered by `memory-first-jobs-segments.test.mjs`,
`memory-first-jobs-budgets.test.mjs` and `memory-processing-segments.test.mjs`.
They test complete wire budgets, original offsets, frozen classification context,
durable private checkpoints and cancellation/source/lease fences. Completing a
segment is not publishing a summary. No model-based reranker or query cache is
introduced; the new feedback and frozen offline comparison are evidence for a
separate, explicitly authorized real-provider quality evaluation.

## Host acceptance is separate

| Host / path | Local evidence | Real-host evidence needed |
| --- | --- | --- |
| Core + desktop console | HTTP, browser, migration and dual-owner tests | Final release deployment and member account acceptance |
| ChatGPT Web / remote OAuth MCP | PKCE/CSRF/resource scopes, callbacks, replay/revocation and SDK tests | Real ChatGPT OAuth consent plus authorized synthetic memory operations |
| Generic MCP | SDK/scoped finite token tests and connection UI | Selected real client's transport, headers and token lifecycle |
| ChatGPT Work / Codex local plugin | Plugin unit/lifecycle contracts and synthetic Console pending/receipt tests | Capture, preview, exact confirm, next-turn delivery and terminal ACK on each supported device |
| OpenClaw | Adapter suite, synthetic Console injection/ACK tests and isolated failure harness | Installed host/version lifecycle and restart/partition cases |
| Hermes | Python adapter suite and real loopback Core-to-Hermes workflow tests | Installed host/version lifecycle and restart/partition cases |

No one host's pass is substituted for another. Freeze the supported host/version
list before public claims; retain the existing seven-day stability gate.

## Retired pages and migration notes

The privacy/retention (`PRV`), registration-code (`INV`) and account-management (`ACC`) pages were removed from the
web Console (old `/app/privacy`, `/app/invitations` and `/app/accounts` URLs redirect to the overview; see
`services/oauth/test/console-removed-pages.test.mjs`). Their IDs are retired. The Core/BFF privacy, retention and
account endpoints are unchanged by that removal. Operator tools: `services/oauth/bin/identity.mjs invite-*`
(registration codes), `console-operator.mjs grant-operator|revoke-operator` (roles) and the new
`console-operator.mjs disable-account|enable-account` (multi-account lockout, same local maintenance path as the
removed web action; `HTTP-CON-09-CLI`). Account privacy defaults and retention now have no web page or CLI: they are
reachable only through the Console action API (`privacy.defaults`, `retention.save`, `retention.prune`).

Session details (SEC-04): a new Console sign-in stores only coarse device-type, browser-family and OS-family values
in `identity_session_clients` (deleted with its session by trigger). No raw User-Agent, IP address or location is
stored; sessions created before this table existed show "not recorded". Like earlier additive OAuth tables, an older
strict OAuth build refuses to open a database containing this table, so a code rollback needs a build whose allowlist
recognizes it. Tests: `services/oauth/test/console-sessions.test.mjs` (SES-01..03).
