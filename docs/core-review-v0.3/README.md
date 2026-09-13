# Core Review v0.3

本更新包含三个核心修复：混合文字检索、搜索组件健康检查和严格事件接收证明。本文是通用变更说明，不包含任何个人环境、真实会话记录或部署验收结果。

## 检索与索引迁移

汉字连续段与非汉字段分别分词，保留紧邻中文的完整工程标识。例如，合成正文 `设备型号为C9800-CL`、`数据库使用SQLite`、`当前版本是17.9.8` 可以用对应标识检索。相近但不同的版本、序列号和地址不能被视为同一精确标识。

索引版本为 `memory-search-v2`。旧索引在 Store 初始化时重建，权威 Memory 正文、来源、Event、Task、Resume 和已有文档 ID 不改写。重建失败时搜索明确不可用，重新打开 Store 可恢复投影。

索引迁移是启动阶段的同步重建，不承诺大型数据库零停机。新旧写进程不得同时操作同一个数据库；回滚也不能用旧备份直接覆盖新增数据。

## 搜索组件健康检查

| 接口 | 合同 |
|---|---|
| `GET /livez` | 存活检查，原响应不变 |
| `GET /readyz` | 数据库检查，仍返回 `{"status":"ready"}`，不代表搜索可用 |
| `GET /readyz/search` | 现有 Bearer API Key 认证，要求 `memory:read`；无认证 401、权限不足 403、搜索可用 200、不可用 503 / `SEARCH_UNAVAILABLE` |

搜索健康响应仅包含组件状态、索引版本和必要错误码。停用、构建中、版本不符或缺失索引对象均不能报 ready。

该接口只做低成本元数据检查，不执行搜索、全库完整性扫描、索引重建、Raw 清理或队列发送。除现有认证流程受节流的凭证使用时间记录外，不写业务数据。它不能代替独立的磁盘和全库完整性检查。

## 严格事件接收证明

删除单个队列原件前，响应必须同时满足：

- `status = accepted`、`received = 1`。
- `inserted` 和 `duplicate` 的值为数值 0 或 1，合计恰好 1；拒绝布尔、字符串、负数和小数计数。JSON 数值 `1.0` 与 `1` 等价。
- `accepted_event_ids` 恰好包含当前不可变队列事件的非空字符串 ID。

缺少、为空、错误或额外 ID，以及畸形计数，均产生 `RECEIPT_MISMATCH`。客户端保留原件并进入 `blocked_reconciliation`；重新发现磁盘队列也不会自动清除该阻塞。只有精确匹配的首次或重复接受证明才能清理队列。

JavaScript、OpenClaw 副本和 Python 使用同一组合同测试向量。此模式不提供汇总回执回退：仅能返回汇总数量的旧服务需要先升级，不能通过删除队列原件绕过对账。

## 可复跑验证

测试使用临时数据库、合成凭证和回环 HTTP 服务，覆盖：

- 中英文连写、中文短词、相近标识、旧精确记录及跨用户／项目隔离。
- 旧索引迁移、中断重建后恢复、业务数据和文档 ID 不变。
- 搜索健康接口权限、故障状态及无维护副作用。
- 服务器提交后返回错误接收证明时，客户端原件不丢失；正常首次和重复接受时清队列。
- 三个事件同步实现的严格响应一致性。

在完整 Git 检出目录中运行：

```bash
node --test server/test/core-review-v03.test.mjs plugins/mnemuron/test/event-acceptance.test.mjs
python3 -m unittest adapters.hermes.test.test_sync_reliability
npm test
node scripts/benchmark-core-memory.mjs review-rerun
```

性能基准只包含合成数据。阈值、测量方法和限制见[检索方案](../core-optimization-v0.2/retrieval-decision.md)。复跑输出保留在被 Git 忽略的 `evidence/` 下，不作为公开发布文件。

## 范围与兼容

仅收紧事件接收分支，不改变 Resume Injection / Delivery Receipt 的所有权、阶段、版本、Session、Turn 或 ACK 校验。Preview → 精确 Confirm → 下一普通轮投递 → 匹配 Stop ACK 的门禁不变。

本更新不添加 OAuth、网页 HTTP MCP 网关、发现／登录／Token 流程、DNS 配置或新依赖。源码回归不等于任何设备的实际部署验收；`production_ready` 保持 `false`。
