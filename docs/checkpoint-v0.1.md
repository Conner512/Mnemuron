# Automatic Checkpoint v0.1

> Public specification and example configuration only. Personal deployment records and acceptance evidence are retained privately. This document is not proof of production readiness; `production_ready=false` remains the release boundary.

## 目标

把已经捕获到中心服务的会话事件转换成可跨设备恢复的不可变 Workstream 快照，同时不把规则提炼结果伪装成人工确认的任务真相。

## 数据流

```text
Raw Events
  └─ Assistant Stop / SessionEnd / 手动请求
       └─ 同 Task + Workstream + Session 的增量事件窗口
            └─ deterministic-rules-v0.1
                 └─ immutable Checkpoint vN
                      ├─ Canonical Reconciliation v0.1
                      │    ├─ 安全的新增进度：版本化自动追加
                      │    └─ 其他变更/冲突：展示后确认
                      └─ Resume Preview
                           └─ 用户确认
                                └─ Resume Packet
```

## 触发规则

- `assistant_message` / `Stop`：有完整 Task、Workstream 和 Session scope 时自动生成。
- `session_end` / `SessionEnd`：仅在上一个 Checkpoint 后出现新的有效内容时生成；只有结束事件时跳过，避免重复版本。
- `POST /v1/sessions/{session_id}/checkpoint`：允许 Adapter 对尚未产生 Stop 的会话手动补建。
- 同一触发事件重复提交时返回既有 Checkpoint，不创建新版本。

## Checkpoint 内容

每个 Checkpoint 保存：

- 当前 Task 目标和本轮用户请求。
- 最近一次 Agent 结果。
- 已完成事项、决定、资源、阻塞、未完成事项和推荐下一步。
- 当前 Task 的 canonical 快照项，以及规则从本轮事件中识别出的派生项。
- Task、Project、Workstream、Session、版本和创建时间。
- 全部来源事件 ID、来源 Device、Agent、Agent Instance。
- 生成方式、可信分数/标签和限制提示。

Checkpoint 是追加写入的不可变记录。Checkpoint 生成过程本身不会更新 `tasks` 表；后续独立的 Canonical Reconciliation v0.1 只允许符合全部安全门槛的新增进度生成版本化 Revision，其他派生内容仍必须先展示再确认。

## v0.1 提炼方法

v0.1 使用本地确定性规则，不调用外部模型：

- 识别显式的“已完成/已通过/已部署”等完成信号。
- 识别显式的“决定/确认采用/必须”等决定信号。
- 识别显式的“失败/无法/阻塞/错误”等阻塞信号，并排除“无阻塞”等否定表达。
- 识别显式的“下一步/接下来/仍需/TODO”等下一步信号。
- 从事件元数据保留工作目录和工具名作为资源线索。

隐含语义可能漏提，因此规则生成的最高可信度限制为 `medium`，Preview 必须展示限制提示。原始事件仍是审计来源。

## 保留与恢复

- Raw Event 到期时清除原始载荷，但事件 ID、时间和来源元数据保留。
- 已生成的 Checkpoint 不随 Raw Event 到期删除，其派生内容和来源事件 ID 继续用于恢复。
- Preview 只读取每个 Workstream 的最新 Checkpoint，同时保留 canonical Task、显式 Memory 和最近活动；各层不能静默互相覆盖。
- Resume Packet 必须携带用户实际看到的同一组 Checkpoint 和同一 Preview 版本。

## API

- `POST /v1/sessions/{session_id}/checkpoint`
- `GET /v1/tasks/{task_id}/checkpoints`
- `GET /v1/tasks/{task_id}/checkpoints?workstream_id={id}&limit={n}`

自动创建结果也会随 `POST /v1/events` 的 `checkpoints` 字段返回，状态为 `created`、`existing`、`skipped` 或 `failed`。

## Checkpoint 组件不处理的内容

- 不直接写回 canonical Task；写回只能经过独立、可审计的 Reconciliation Proposal 和 Revision。
- 不自行判断跨 Workstream 冲突或自动合并分支。
- 不执行 Project/Task 语义 Resolver。
- 不自动确认或注入 Resume Packet。
- 不声称理解隐含决定、因果关系或完整执行状态。
