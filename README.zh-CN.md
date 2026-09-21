# Mnemuron

**面向 AI Agent 的自托管记忆系统，支持独立可选的任务交接。**

[English](README.md) · 简体中文

Mnemuron 保留记忆的来源和版本，让授权的 Agent 跨会话、跨设备检索并读取信息。记忆功能不依赖任务交接；需要接续工作时，再通过独立的预览与确认流程恢复上下文，不把派生摘要当作权威任务状态。

中心服务使用 SQLite 存储数据。适配器将宿主生命周期事件接入服务，并在服务暂时不可用时保留本地待发送队列。不依赖云端记忆服务或外部向量数据库。

> **当前状态：实验阶段。** 默认仍为单 owner 自托管，另提供需显式启用的账户隔离控制台供本地评估；部署及恢复策略需单独审查。API、数据结构和宿主集成仍可能变化。`production_ready` 保持 `false`；提供适配器源码不等于承诺兼容所有宿主版本或部署环境。

## 能解决什么问题？

- **跨会话接续工作。** 发现项目、选择任务或来源分支，核对 Resume Preview，明确确认后再投递。
- **保留上下文来源。** 记录保留 Agent、Session 和 Workstream 信息；恢复任务不会把目标 Agent 的工作流改写成来源工作流。
- **区分事实与摘要。** 权威任务状态、自动派生 Checkpoint 和结构化记忆是不同记录，不能互相冒充。
- **检索并修订记忆。** 使用 SQLite FTS5 检索指定范围内的记忆，读取完整正文，并通过替代或撤回来管理生命周期。
- **从 ChatGPT 网页版读取记忆。** 可选 OAuth 网关提供版本固定的分页读取、派生摘要和检索模式选择；不开放网页写入、项目恢复或 handoff。逐条授权和不含正文的读取审计，让每次访问可核查。
- **观察恢复投递状态。** 持久队列、幂等重试和回执将“已排队”“已投递”“本轮已完成”区分开来。

## 工作方式

```text
ChatGPT / Codex  ─┐
OpenClaw        ─┼─ 适配器 + 本地队列 ─► Mnemuron API ─► SQLite / WAL
Hermes          ─┘
```

**Event** 是捕获的活动记录。**Checkpoint** 是带来源引用的派生快照。**Canonical Task** 是权威任务状态，通过对账规则更新，而不是被每一份摘要直接覆盖。**Memory** 是有明确作用域和独立生命周期的可复用信息。

恢复流程为：**Preview → 明确 Confirm → 下一普通轮次 → 投递 → 匹配的完成 ACK**。预览不会注入上下文；确认成功也不代表目标 Agent 已经收到或完成交接。具体投递方式由适配器决定。

## 快速开始：运行本地 API

需要 **Node.js 24+**（包含 `node:sqlite` 和 FTS5）、Git 和 POSIX shell。服务端没有第三方 npm 运行依赖；Hermes 适配器及完整测试集还需要 Python 3。

```bash
git clone https://github.com/Conner512/Mnemuron.git
cd Mnemuron
umask 077
MNEMURON_EXAMPLE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mnemuron-example.XXXXXX")"

MNEMURON_HOST=127.0.0.1 \
MNEMURON_PORT=47831 \
MNEMURON_DATABASE_PATH="$MNEMURON_EXAMPLE_DIR/mnemuron.sqlite3" \
  node server/bin/mnemuron-server.mjs
```

在另一个终端检查：

```bash
curl --fail http://127.0.0.1:47831/livez
curl --fail http://127.0.0.1:47831/readyz
```

这两个接口分别检查进程存活和数据库就绪，**不能**证明搜索、适配器捕获或 Resume 交接成功。使用 `Ctrl+C` 停止服务；合成数据保留在仓库外新建的临时目录。真实数据应使用所有 Git worktree 之外的私有持久目录。

无需新建任务或交接的独立记忆模式，见 [memory-only 配置与存储检查](docs/memory-first-v0.1/README.md)。旧部署不配置新开关时保留原有 handoff 行为，不会静默切换。

**下一步：[创建 Agent 凭证，保存并检索一条记忆](docs/getting-started.md)。** 本例只运行本地 API，不安装宿主插件，也不对网络开放服务。远端客户端应使用 HTTPS 和各自独立的 Agent 凭证。

## Agent 集成

| 集成 | 实现方式 | 文档入口 |
| --- | --- | --- |
| ChatGPT / Codex 插件 | 本地 MCP 服务、Skill、宿主生命周期 Hook；MCP Delivery Receipt 流程 | [插件指南](plugins/mnemuron/README.md) |
| OpenClaw | 原生插件、生命周期 Hook 和 `/mnemuron` 命令 | [适配器指南](adapters/openclaw/README.md) |
| Hermes | Python 用户插件、生命周期 Hook 和 `/mnemuron` 命令 | [适配器指南](adapters/hermes/README.md) |
| ChatGPT 网页版 / 远端 MCP | 可选 OAuth 服务及无状态只读 HTTP 网关，与宿主 Hook 分离 | [OAuth 指南](docs/chatgpt-web-oauth-v0.1/README.md) |

这些是源码集成，并非通用安装器。应在目标宿主中分别核验插件加载、Hook 权限和会话身份。仅连接 MCP 不能证明生命周期捕获或完成 ACK 正常。可选网页网关已用合成数据完成本地测试，仍需独立部署和真实 ChatGPT 验证；它不捕获对话，也不恢复任务。

## 文档

- [快速开始](docs/getting-started.md)：带身份认证的本地 API 示例。
- [文档索引](docs/README.md)：概念、协议、适配器与运维文档。
- [账户控制台预览](docs/integrated-console-v0.3.md)：注册码注册、本地 TOTP、逐账户读取、迁移，以及仍关闭的高风险操作。
- [核心规格](docs/core-spec-v0.1.md)：数据模型与任务连续性边界。
- [部署指南](docs/pve-lxc-deployment-v0.1.md)：可选的 Linux/LXC 部署示例；核心 API 不要求使用 Proxmox。
- [核心优化说明](docs/core-optimization-v0.2/release-notes.md)与[检索及同步修订](docs/core-review-v0.3/README.md)：实现变更和兼容性说明。

## 开发

在完整 Git 克隆中执行：

```bash
npm test
node scripts/check-publication.mjs --worktree
```

迁移回归使用仓库内经过哈希校验的冻结旧版测试文件。测试使用合成记录和可丢弃本地存储；OAuth 测试还需安装两份独立锁定的依赖。聚合测试会拒绝“零测试”和未获明确许可的跳过，避免误报通过。定向测试及提交规范见 [CONTRIBUTING.md](CONTRIBUTING.md)。

```text
server/             HTTP API、SQLite 存储、管理工具与测试
plugins/mnemuron/   ChatGPT / Codex 插件
adapters/           OpenClaw、Hermes 与可选只读 HTTP MCP 集成
services/oauth/     可选密码 + TOTP 授权服务
web/console/        同域桌面控制台、颜色主题与双语字典
shared/             OAuth 与网关共用的边界检查
scripts/            性能基准、回归运行器与发布内容检查
docs/               指南、规格与测试计划
```

## 当前边界

- 默认单 owner，逐账户隔离与桌面控制台需显式启用；不是托管式多租户服务，也不是生产认证。
- 词法/全文检索无需模型；可选的 Embedding 与 Qdrant 模块支持混合和语义检索，但必须配置查询外发许可与预算。混合降级会明确标记，语义搜索不可用时返回错误。
- 派生摘要保留来源版本和覆盖范围；只读摘要查询不会启动模型任务，详见 [Memory First](docs/memory-first-v0.1/README.md)。
- 自动摘要可能遗漏上下文，来源记录与明确的任务状态始终分开保留。
- 捕获和投递依赖宿主 Hook 与权限，不保证任意宿主中的完整捕获。
- 测试计划描述验收要求，不是生产认证或特定环境的部署履历。

## 参与贡献

欢迎问题反馈、文档改进和聚焦的代码补丁。请先阅读[贡献指南](CONTRIBUTING.md)，然后[提交缺陷](https://github.com/Conner512/Mnemuron/issues/new?template=bug_report.yml)或[提出改进建议](https://github.com/Conner512/Mnemuron/issues/new?template=feature_request.yml)。

反馈中请使用合成示例，不要上传真实对话、记忆导出、凭证、数据库或私有基础设施信息。详见[公开内容规范](docs/publication-policy.md)。

## 许可证

Mnemuron 采用 [Apache License 2.0](LICENSE)，署名信息见 [NOTICE](NOTICE)。第三方运行时与 Agent 宿主仍遵循各自的许可证。
