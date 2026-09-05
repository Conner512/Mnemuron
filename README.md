# Mnemuron

> **One user. One memory. Any agent.**

Mnemuron 是面向单个用户的跨设备、跨 Agent 任务连续性系统。它将完整原始记录、结构化任务记忆、Checkpoint 和经用户确认的 Resume Packet 分开处理。

## 项目内容

- 中心 API、SQLite/WAL 存储、每个 Agent 独立凭证、事件 outbox、保留期清理与审计。
- Project 与 Task 识别、只读项目和分支预览、显式 Resume Preview/Confirm、下一轮投递及终态 ACK。
- 持久 Task Scope、自动 Checkpoint、结构化记忆检索与生命周期，以及来源可追溯的 Canonical Task 对账。
- ChatGPT、OpenClaw 和 Hermes 的 Adapter 源码与测试；各 Adapter 的功能覆盖和验收应分别确认。

公开仓库仅包含通用规格、示例配置和可重复运行的测试。个人部署记录、真实会话与聊天身份、运行数据和原始验收证据保留在私有归档中。示例中的 `example.com`、`/Users/example` 和设备标签均为占位符，请按自己的环境配置。`production_ready` 保持 `false`；公开文档不构成任何部署的生产验收证明。

核心规格见 [Core Specification](docs/core-spec-v0.1.md)，部署入口见 [PVE LXC Deployment](docs/pve-lxc-deployment-v0.1.md)。功能规格包括 [Task Scope](docs/dynamic-task-scope-v0.1.md)、[Task Bootstrap](docs/task-bootstrap-binding-v0.1.md)、[Project Bootstrap](docs/project-bootstrap-initial-task-v0.1.md)、[Branch-aware Resume](docs/branch-aware-resume-selection-v0.1.md) 和 [Memory Lifecycle](docs/structured-memory-retrieval-lifecycle-v0.1.md)。发布前按 [Production Readiness](docs/production-readiness-v0.1.md) 与[验收矩阵](docs/production-readiness-evidence-matrix-v0.1.md)收集当前环境的证据。

## 验证

需要 Node.js 24 或更高版本：

```bash
npm test
```
