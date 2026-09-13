# Mnemuron v0.1 Core Specification

> Public specification and example configuration only. Personal deployment records and acceptance evidence are retained privately. This document is not proof of production readiness; `production_ready=false` remains the release boundary.

> **One user. One memory. Any agent.**

| 字段 | 值 |
| --- | --- |
| 状态 | 产品核心规格；部署验收结果独立记录 |
| 首轮验证 | Device A ChatGPT Desktop ↔ Device B ChatGPT Desktop |
| 参考部署 | PVE LXC，通过受控内网访问 |

## 1. 文档目的

本文档定义 Mnemuron v0.1 的产品边界、领域对象、交互流程、概念 API、认证、保留策略、部署边界与验收标准。

Mnemuron 是全新项目。本规格不继承其他记忆项目的代码、数据结构、存储方案、API、插件机制或界面设计。数据库、编程语言、框架和具体 ChatGPT Desktop 接入方式均由后续技术验证重新选择。

本文中的“必须”表示 v0.1 验收不可缺少；“应该”表示默认实现方向，若改变需记录原因；“可以”表示可选能力。

## 2. 产品定义

Mnemuron 是面向单个用户、以任务为中心的 Agent 连续性系统。

用户可以在不同设备和不同 Agent 之间切换，而不需要手工重述任务历史。Mnemuron 负责记录任务过程、识别同一项目和任务、维护并行工作进度，并在用户确认后向新的 Agent 提供可追溯的恢复上下文。

Mnemuron 不是单纯的聊天记录搜索器。其核心价值是把分散在 Agent、设备和会话中的信息组织成可以继续执行的任务状态。

## 3. 已确认产品决策

1. v0.1 服务单个用户。
2. 首轮部署在 PVE LXC。
3. 客户端通过受控内网访问中心服务。
4. 首轮只验证 Device A 与 Device B 上的 ChatGPT Desktop。
5. 后续接入运行在虚拟化平台、通过 Telegram Bot 使用的 OpenClaw 与 Hermes。
6. Mnemuron 可以保存集成入口能够读取的完整对话，不设置内容类别排除规则。
7. 每条记录必须带有设备、Agent、Agent 实例、会话和时间来源。
8. 项目通过名称、别名、仓库、路径、项目指纹和历史确认等信号组合识别。
9. 同一任务允许多个设备或 Agent 并行工作。
10. 自动恢复必须先展示 Resume Preview，获得用户确认后才可注入 Agent。
11. API Key 是 v0.1 的客户端认证方式；每个 Agent 实例使用独立凭证。
12. 完整原始记录的保存时间可配置，最短 1 天、最长永久，默认 30 天。
13. 原始记录到期不自动删除结构化任务记忆和 Checkpoint。

## 4. v0.1 范围

### 4.1 必须完成

- 在 PVE LXC 上提供一个可由两台 Mac 访问的 Mnemuron 服务。
- 分别注册 Device A 与 Device B 上的 ChatGPT Desktop 实例。
- 完整捕获可读取的对话并记录可靠来源。
- 组合识别项目和任务。
- 维护任务、工作流分支、会话、原始事件和 Checkpoint。
- 支持自然语言“继续 xxx 任务”和等价的 `/Mnemuron continue xxx` 语义。
- 恢复前展示 Resume Preview，确认后返回可注入的 Resume Packet。
- 支持两台设备同时继续同一任务，不静默覆盖任何一方的记录。
- 提供 API Key 的签发、验证、轮换和撤销能力。
- 执行 1 天至永久的原始记录保留策略。
- 提供来源查看、审计和明确删除能力。

### 4.2 后续协议验证

- OpenClaw Telegram Bot 接入，用于证明跨 Agent 连续性。
- Hermes Telegram Bot 接入，用于证明多个 Agent 的并行任务视图。

跨设备与跨 Agent 连续性必须分别验收；只有当前部署的相应实机证据通过后，才能声明该范围已经验收。

## 5. 核心原则

### 5.1 任务身份独立于会话

任务不能等同于某个 ChatGPT 对话。设备、Agent 和会话可以改变，`task_id` 必须保持不变。

### 5.2 完整历史与可执行状态分离

Mnemuron 同时维护：

- **Raw Event**：完整对话和原始过程，提供事实来源。
- **Structured Memory**：从历史中形成的目标、决定、事实、阻塞和下一步。
- **Checkpoint**：某个工作分支在特定时间的可恢复状态。
- **Resume Packet**：为一次具体恢复请求生成、经用户确认后交给 Agent 的上下文包。

Raw Event 不是 Structured Memory；Resume Packet 也不是原始历史的完整转储。

### 5.3 先确定范围，再选择内容

恢复时必须先确定用户、项目、任务和工作分支范围，再从该范围中生成 Resume Preview。不得先检索全部内容再在客户端隐藏不相关结果。

### 5.4 来源不可丢失

任何结构化记忆、Checkpoint 和 Resume Packet 都必须能够追溯到其来源事件，并显示对应的设备、Agent、会话与时间。

### 5.5 并行追加，不做最后写入覆盖

多个工作分支可以持有不同结论。Mnemuron 必须保留每个分支的事实和来源，不得使用“最后写入者获胜”静默覆盖冲突。

### 5.6 预览后注入

任务匹配、上下文生成可以自动完成；向 Agent 注入上下文必须在用户看到预览并确认后进行。

## 6. 领域对象

### 6.1 User

单个记忆所有者。v0.1 只支持一个用户，但所有数据仍必须带有 `user_id`，避免未来数据迁移时无法区分所有权。

### 6.2 Device

承载 Agent 实例的物理机或虚拟机。

最小字段：

- `device_id`
- 用户可识别名称
- 设备类型与平台
- 注册、最后在线和撤销时间
- 当前状态

### 6.3 Agent 与 Agent Instance

`agent_id` 表示逻辑 Agent 类型，例如 ChatGPT、OpenClaw 或 Hermes。`agent_instance_id` 表示安装在某台设备上的具体运行实例。

两台 Mac 上的 ChatGPT 可以共享 Agent 类型，但必须拥有不同的 `device_id`、`agent_instance_id` 和 API Key。

### 6.4 Project

长期存在的项目身份，不依赖单一设备路径。

最小字段：

- `project_id`
- 名称与别名
- 已确认的识别信号
- 创建和更新时间
- 原始记录保留策略覆盖值

### 6.5 Task

跨 Agent、设备和会话保持连续的工作单元。

最小字段：

- `task_id`
- `project_id`
- 标题、别名和目标
- 状态：`active`、`paused`、`completed`、`archived`
- 创建、最后活动和完成时间

### 6.6 Workstream

同一 Task 下的一条独立工作线，用于支持多个设备或 Agent 并行执行。

最小字段：

- `workstream_id`
- `task_id`
- 创建来源 Agent、设备和会话
- 状态：`active`、`paused`、`completed`、`merged`
- 父工作流分支，可为空

### 6.7 Session

一个 Agent 实例与 Mnemuron 之间有开始和结束边界的交互期。

Session 必须关联一个 Agent 实例和设备；在任务确认前可以不关联 Task，确认后必须关联 Project、Task 和 Workstream。

### 6.8 Raw Event

Mnemuron 接收的原始事件。v0.1 至少支持：

- 用户消息
- Agent 回复
- 会话开始与结束
- 恢复预览、确认和注入结果
- 可读取时的工具调用、结果、文件或外部资源引用

最小字段：

- `event_id`
- `session_id`
- 事件类型与原始载荷
- 服务端写入的 Agent、设备和时间来源
- `project_id`、`task_id`、`workstream_id`，允许捕获早期为空
- `expires_at`，永久保留时为空

### 6.9 Structured Memory

从显式输入或历史中形成的结构化信息，至少包含以下类型：

- 目标
- 事实
- 用户或项目约束
- 决定及原因
- 已完成事项
- 阻塞
- 未完成事项
- 推荐下一步

每条 Structured Memory 必须保存 scope、来源事件引用和当前有效状态。冲突内容不得在无记录的情况下覆盖。

### 6.10 Checkpoint

某个 Workstream 在特定时间的可恢复状态，至少包含：

- 当前目标
- 已完成事项
- 关键决定及原因
- 使用的文件、仓库或资源
- 当前阻塞
- 未完成事项
- 推荐下一步
- 来源事件列表
- 创建该 Checkpoint 的 Agent、设备、会话与时间

### 6.11 Resume Preview 与 Resume Packet

Resume Preview 是面向用户的恢复确认内容。Resume Packet 是用户确认后交给 Agent 的机器可用上下文。

二者必须来自同一个不可变 `resume_id` 和版本，避免用户确认后内容发生变化。

### 6.12 Canonical Task Reconciliation

Canonical Task 是跨 Agent 共享的当前任务状态。Checkpoint 不能直接覆盖它；服务必须先生成带来源的字段级 Reconciliation Proposal。

每次成功变更必须形成单调递增的 `canonical_version` 和不可变 Revision。只有无冲突、来源明确的新增进度可以按冻结策略自动追加；删除、替换、状态变化和冲突选择必须先展示并由用户确认。并发变更必须使用基线版本校验，禁止最后写入者静默覆盖。

Resume 确认与 Reconciliation 确认是两个独立动作，不能相互代替。

### 6.13 API Credential

每个 Agent Instance 使用独立 API Key。Credential 至少保存：

- Credential ID
- 绑定的 User、Device、Agent 和 Agent Instance
- 权限范围
- Key 的不可逆摘要，不保存可还原明文
- 创建、最后使用、过期、轮换和撤销时间

### 6.14 Audit Event

记录注册、认证失败、读取、确认、注入、策略变更、删除、过期清理、Key 轮换和撤销等关键操作。

## 7. 项目与任务识别

### 7.1 Project Resolver

Project Resolver 可以使用以下组合信号：

- 用户显式选择的项目或别名
- Git remote 或其他仓库标识
- 项目文件或仓库指纹
- 工作目录与路径
- 当前对话中的项目名称
- 历史任务关联
- 用户过去确认过的匹配

路径只能作为信号之一，不能成为唯一项目身份。

### 7.2 Task Resolver

Task Resolver 可以使用：

- 用户输入的任务名称或描述
- 已选项目
- Task 标题与别名
- 最近活动时间
- 当前 Agent 与设备的历史关联
- 任务目标和历史内容的相关性

### 7.3 歧义处理

- 只有一个高可信候选时，系统直接展示其 Resume Preview。
- 存在多个合理候选时，系统必须先展示候选列表。
- 未达到最低可信要求时，系统必须说明未找到，而不是创建虚假连续性。
- 用户的选择必须成为后续识别信号，但不得抹除之前的错误候选记录。

## 8. 自动恢复流程

1. 用户在新的 Agent 或设备中输入“继续 xxx 任务”。
2. Adapter 将请求和当前环境信号发送到 Mnemuron。
3. Mnemuron 依次解析 Project、Task 和相关 Workstream。
4. Mnemuron 生成带版本的 Resume Preview。
5. Adapter 向用户展示任务目标、进度、决定、资源、阻塞、下一步、来源 Agent、设备和分支。
6. 用户确认、取消或选择其他候选。
7. 确认后，Mnemuron 固化 Resume Packet，并返回给 Adapter。
8. Adapter 将 Resume Packet 注入当前 Agent，并向 Mnemuron发送注入结果确认。
9. 当前 Agent 默认创建新的 Workstream；用户也可以显式选择继续原 Workstream。
10. 后续事件写入新的 Session 和选定 Workstream。

如果 Adapter 没有上报注入成功，Mnemuron 不得把任务标记为已恢复。

## 9. 手动交互语义

以下命令是跨 Agent 一致的产品语义，不要求所有客户端原生实现真正的斜杠命令：

- `/Mnemuron continue <任务>`：查找任务并展示 Resume Preview。
- `/Mnemuron load project <项目>`：展示项目级记忆，确认后加载。
- `/Mnemuron status`：列出最近项目、任务、工作分支和活动来源。
- `/Mnemuron branches <任务>`：查看并行 Workstream、Checkpoint 和冲突。
- `/Mnemuron remember <内容>`：显式保存一条结构化记忆。

自然语言“继续 xxx 任务”必须与 `/Mnemuron continue xxx` 使用同一后端流程和确认规则。

## 10. 并行与冲突

### 10.1 并行规则

- Task 可以同时拥有多个 active Workstream。
- 每条 Raw Event 和 Structured Memory 必须标记其 Workstream。
- Resume Preview 必须显示当前活跃分支及其最近活动来源。
- 用户可以选择一个分支、多个分支的合并视图，或创建新分支。

### 10.2 冲突规则

- 不同分支对同一事实或决定产生不一致内容时，系统必须保存双方。
- 冲突项必须显示来源、时间和各自依据。
- 自动生成的合并摘要必须标记为派生内容，并引用所有使用的来源。
- 合并不得删除、改写或隐藏原始分支记录。
- 改变任务的规范状态前必须展示差异；具体确认 UX 在实现设计中确定。

## 11. 捕获策略

### 11.1 v0.1 默认行为

在集成入口允许的范围内捕获完整会话，包括用户和 Agent 的完整消息。若可获得工具、文件和资源事件，也应原样记录并建立来源关联。

v0.1 不按内容类别过滤原始记录。由于载荷可能包含敏感内容：

- 运维日志不得再次复制完整请求载荷或 API Key。
- API Key 不得写入 Raw Event。
- 读取和导出必须经过认证并产生审计记录。

这些安全控制不改变“完整对话可以进入 Mnemuron”的产品决定。

### 11.2 捕获完整性状态

每个 Session 必须声明实际捕获能力，例如：

- 完整双向对话
- 只有用户消息
- 只有 Agent 回复
- 是否包含工具和文件事件
- 是否缺少会话结束事件

系统不得在接入能力不足时声称已保存完整对话。

## 12. 保留、过期与删除

### 12.1 原始记录策略

- 最短保存时间：1 天。
- 最长保存时间：永久。
- 默认保存时间：30 天。
- 配置层级：系统默认、Project 覆盖、Session 覆盖。
- Session 的显式配置优先于 Project，Project 优先于系统默认。
- 永久保留以明确状态表示，不使用易与立即过期混淆的数值。

### 12.2 策略变更

- 新策略默认只影响变更后创建的 Raw Event。
- 修改已有数据的到期时间必须先展示预计影响的记录数、时间范围和不可恢复影响，并获得确认。
- 自动到期清理不需要逐条确认，但必须产生审计记录和清理结果。

### 12.3 到期结果

Raw Event 到期后删除原始载荷。系统可以保留不含原文的最小审计元数据，包括 ID、事件类型、时间、Agent、设备、过期时间和删除原因。

由 Raw Event 形成的 Structured Memory 与 Checkpoint 默认继续保留，其来源状态显示为“原始内容已过期”。用户显式删除 Task、Memory 或 Project 时使用独立的删除流程。

## 13. 认证与访问控制

### 13.1 API Key 模型

- 每个 Agent Instance 使用独立 API Key。
- API Key 通过 `Authorization: Bearer <key>` 或后续等价的安全传输方式提交。
- 服务端根据 Key 绑定关系写入 `user_id`、`device_id`、`agent_id` 和 `agent_instance_id`，客户端不能覆盖这些来源字段。
- Key 必须支持最小权限、轮换、撤销和最后使用时间查看。
- 服务端只保存 Key 的不可逆摘要；明文只在签发时显示一次。

### 13.2 建议权限范围

- `capture:write`
- `memory:read`
- `memory:write`
- `resume:read`
- `resume:confirm`
- `audit:read`
- `admin:devices`
- `admin:retention`

首轮两个 ChatGPT 实例可以拥有捕获、读取、写入和恢复权限；管理权限使用独立的管理 Credential。

### 13.3 网络与传输

PVE LXC 服务默认只监听 SD-WAN 可达的内网地址，不默认暴露到公网。即使位于内网，生产化使用仍必须保护传输内容，具体 TLS、内部证书或其他方案在技术设计阶段确定。

## 14. 概念 API 契约

本节定义行为边界，不确定具体框架或存储实现。

### 14.1 Agent 与设备

- `POST /v1/agent-instances/register`：注册设备与 Agent Instance，签发独立 API Key。
- `POST /v1/agent-instances/{id}/rotate-key`：轮换 Key。
- `POST /v1/agent-instances/{id}/revoke`：撤销实例访问。

注册和管理接口必须使用管理 Credential，普通 Agent Key 不可创建新的高权限 Key。

### 14.2 Session 与捕获

- `POST /v1/sessions`：开始 Session 并声明捕获能力。
- `POST /v1/sessions/{id}/events`：批量追加 Raw Event。
- `POST /v1/sessions/{id}/checkpoint`：创建 Workstream Checkpoint。
- `POST /v1/sessions/{id}/close`：结束 Session 并提交最终状态。

事件写入必须支持幂等键，避免客户端重试造成重复记录。

### 14.3 解析与恢复

- `POST /v1/projects/resolve`：根据组合信号解析 Project。
- `POST /v1/tasks/resolve`：在已确定的范围内解析 Task。
- `POST /v1/resume/preview`：创建不可变、带版本的 Resume Preview。
- `POST /v1/resume/{resume_id}/confirm`：确认 Preview 并取得 Resume Packet。
- `POST /v1/resume/{resume_id}/ack`：报告实际注入成功或失败。

Resume confirm 必须校验用户确认的 Preview 版本；版本已经变化时，应重新展示差异，不可悄悄确认新内容。

### 14.4 Canonical Task 对账

- `GET /v1/tasks/{task_id}/reconciliation`：读取 canonical 版本、待确认提案、冲突和最近 Revision。
- `POST /v1/tasks/{task_id}/reconciliation/run`：按最新 Checkpoint 或显式字段操作生成幂等 Proposal；`derive_checkpoint_operations=false` 仅在同时提供显式 `operations` 与 `source_checkpoint_ids` 时允许引用证据但不导入规则派生操作。
- `POST /v1/task-reconciliations/{proposal_id}/resolve`：使用 Proposal 版本与 canonical 基线版本确认或拒绝。

当已有 `awaiting_confirmation` Proposal 时，无显式人工操作的 `run` 必须冻结并返回同一 Proposal。期间新建的 Checkpoint 返回 `deferred_pending_confirmation`，不得改写、合并或 supersede 已展示的 Proposal；Task 状态通过 `deferred_checkpoints` 和 `deferred_checkpoint_ids` 暴露延迟证据，精确确认或拒绝响应也返回这些 ID，供 Proposal 解决后按新 canonical 版本显式重算。
- `GET /v1/tasks/{task_id}/canonical-revisions`：读取版本化、可追溯的 Canonical Task 变更记录。

普通 Adapter 使用独立的 `task:reconcile:read` 与 `task:reconcile:confirm` 权限，不获得 `admin:tasks`。

### 14.5 查询与管理

- `GET /v1/tasks/{task_id}`：读取任务状态。
- `GET /v1/tasks/{task_id}/workstreams`：读取并行分支和最近 Checkpoint。
- `POST /v1/memories/query`：在明确 scope 内查询 Structured Memory。
- `POST /v1/memories`：显式保存 Structured Memory。
- `DELETE /v1/memories/{memory_id}`：明确删除记忆。
- `GET /v1/retention`：读取当前保留策略。
- `PUT /v1/retention`：更新保留策略；影响历史数据时必须使用预览确认流程。
- `GET /v1/audit`：读取审计记录。

### 14.6 Resume Preview 最小响应

Resume Preview 至少包含：

- 匹配到的 Project 与 Task
- 匹配原因和可信状态
- 当前任务目标与状态
- 候选 Workstream 及最近 Agent、设备和活动时间
- 已完成事项
- 关键决定及原因
- 当前阻塞与未完成事项
- 推荐下一步
- 相关文件、仓库或外部资源
- 冲突提示
- 来源摘要
- Preview 版本和过期时间

## 15. PVE LXC 部署边界

```text
Device A ChatGPT Desktop ─┐
                          ├── SD-WAN 内网 ── Mnemuron API / PVE LXC
Device B ChatGPT Desktop ──┘                     │
                                                ├── 权威数据与原始记录
                                                ├── Project / Task Resolver
                                                ├── Checkpoint / Resume 服务
                                                ├── Retention Worker
                                                └── Audit
```

### 15.1 LXC 内部职责

- API、认证和审计。
- Project 与 Task 解析。
- Session、Event、Memory、Checkpoint 和 Resume 状态管理。
- 原始记录到期清理。
- 持久状态的导出、备份与恢复接口。

### 15.2 客户端职责

- 捕获 ChatGPT Desktop 可读取的消息和事件。
- 提交环境与项目组合信号。
- 展示候选、Resume Preview 和确认操作。
- 用户确认后向 ChatGPT 注入 Resume Packet。
- 上报注入结果和后续事件。
- 在网络不可用时明确显示未同步状态，不伪装成已保存。

### 15.3 持久化要求

- 持久数据必须独立于可替换的应用运行时。
- LXC 或应用服务重启后，Task、Event、Checkpoint、Credential 状态和审计不得丢失。
- 数据库和存储技术在技术选型阶段决定，本规格不预设实现。
- 必须能够验证备份可恢复，而不只是生成备份文件。

## 16. v0.1 验收用例

### AC-01：实例身份

Device A 和 Device B 的 ChatGPT Desktop 使用不同 API Key。两端写入的数据具有正确且不可由客户端覆盖的 Device、Agent 和 Agent Instance 来源。

### AC-02：完整捕获声明

Device A 开始一个测试任务。Mnemuron 保存集成入口能够读取的完整双向对话，并准确显示实际捕获能力；缺失的工具、文件或结束事件必须被明确标记。

### AC-03：组合项目识别

同一项目在两台 Mac 使用不同本地路径时，Mnemuron 根据组合信号识别为同一个 Project。信号不足时展示候选，不误建或误载其他项目。

### AC-04：跨设备恢复

用户在 Device B 输入“继续 <测试任务>”。系统正确识别 Task，展示 Resume Preview；用户确认前不向 ChatGPT 注入上下文。

### AC-05：确认与注入闭环

确认后，Device B 获得与 Preview 同版本的 Resume Packet。Adapter 上报注入成功，系统才记录恢复完成；注入失败时保留失败状态并允许重试。

### AC-06：并行 Workstream

两台 Mac 同时继续同一 Task 时，各自写入独立 Workstream。双方事件、Checkpoint 和决定均被保留。

### AC-07：冲突不覆盖

两端提交相反决定时，系统展示冲突双方、来源和时间，不使用最后写入结果覆盖另一方。

### AC-08：凭证撤销

撤销 Device B 的 API Key 后，该实例不能继续读取或写入；Device A 不受影响。撤销操作写入审计。

### AC-09：保留策略

可以为测试 Session 设置 1 天保存，也可以设置永久。到期清理删除 Raw Event 载荷，但保留允许的最小审计元数据；Structured Memory 和 Checkpoint 仍可用于恢复，并显示原始来源已过期。

### AC-10：重启与恢复

重启 Mnemuron 应用或 LXC 后，已确认的 Project、Task、Workstream、Checkpoint、Credential 状态和审计保持一致，并能继续完成 Resume 流程。

## 17. v0.1 非目标

- 多用户、团队和租户管理。
- 公网服务或云端托管产品。
- 设备离线后的双向合并。
- OpenClaw 与 Hermes 的正式验收。
- 自动替用户决定冲突的正确版本。
- 未经预览确认的自动上下文注入。
- 自主规划、自动推理或人格模拟。
- 完整图形化记忆关系界面。
- 在本规格阶段确定数据库、向量索引、框架或编程语言。

## 18. 实现前技术验证项

以下问题不改变产品模型，但实现前必须解决：

1. ChatGPT Desktop 当前可用的消息捕获、命令触发和上下文注入入口。
2. Device A 与 Device B Adapter 的安装、升级和撤销方式。
3. PVE LXC 的 IP、DNS、证书、资源和持久卷规划。
4. 权威存储、原始载荷存储和搜索实现的技术选型。
5. Project 与 Task Resolver 的信号格式、可信阈值和可解释输出。
6. Resume Preview 在 ChatGPT Desktop 中的实际展示与确认交互。
7. 完整捕获情况下的容量预估、备份频率和恢复目标。

只有第 1 项会直接决定 ChatGPT Desktop Adapter 能否做到无感；如果官方入口无法提供完整捕获或直接注入，Adapter 必须如实声明能力降级，不能用不完整链路冒充完整闭环。
