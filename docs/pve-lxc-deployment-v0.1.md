# Mnemuron PVE LXC Deployment v0.1

> Public specification and example configuration only. Personal deployment records and acceptance evidence are retained privately. This document is not proof of production readiness; `production_ready=false` remains the release boundary.

## 文档边界

本指南描述单用户中心服务的通用部署步骤。实际地址、容器编号、设备身份、凭证与验收记录由部署者私下维护，本文不声明任何部署已经通过验收。

每个 Agent 实例使用独立 API Key，经同一 HTTPS 地址访问中心 API。首次上线应验证事件写入、Preview/Confirm/下一轮投递/终态 ACK、凭证隔离、服务重启持久性与备份恢复。

## 运行要求

- Debian/Ubuntu LXC。
- Node.js 24 或更高版本。服务只使用 Node 内置模块，包括 `node:sqlite`，没有 npm 生产依赖。
- 持久目录 `/var/lib/mnemuron`。
- 默认监听 `127.0.0.1:47831`，由内网 TLS 反向代理提供给 SD-WAN 客户端。
- LXC 至少预留 1 vCPU、512 MiB 内存；原始记录容量根据实际捕获量另行测算。
- `MNEMURON_MAX_BODY_BYTES` 控制单次 JSON 请求体上限，允许范围为 64 KiB 到 64 MiB；代码默认 2 MiB；需要更大完整 Hook 记录时，应根据容量测试结果显式调整。超过上限时服务会完整消费请求并返回明确的 413，避免反向代理将上游提前断开误报为 502。

不要将 SQLite 数据库放在 SMB、NFS 或其他多主网络共享目录。两台 Mac 只访问 API，由 LXC 内的 SQLite/WAL 负责并发写入。

## 文件布局

```text
/opt/mnemuron/server/                 应用代码，只读
/etc/mnemuron/mnemuron.env            运行配置，root:mnemuron 0640
/var/lib/mnemuron/mnemuron.sqlite3    权威数据库，mnemuron:mnemuron 0600
/etc/systemd/system/mnemuron.service  systemd 单元
/var/lib/mnemuron/backups/scheduled/  每日校验备份，mnemuron:mnemuron 0700
/etc/systemd/system/mnemuron-backup.*  定时备份 service/timer
```

## 首次部署流程

以下流程应在已创建的 LXC 内执行；创建用户、复制文件、启用服务属于实际系统变更，应在确认目标 LXC 后进行。

1. 创建不可登录的 `mnemuron` 系统用户和三个目录。
2. 将仓库的 `server/` 复制到 `/opt/mnemuron/server/`。
3. 将 `server/config/mnemuron.env.example` 复制到 `/etc/mnemuron/mnemuron.env`。
4. 将 `server/systemd/mnemuron.service` 安装到 systemd。
5. 先以前台方式启动并检查 `/livez`、`/readyz`，再启用 systemd。
6. 使用管理命令签发一次性显示的 Admin API Key：

```bash
MNEMURON_DATABASE_PATH=/var/lib/mnemuron/mnemuron.sqlite3 \
  node /opt/mnemuron/server/bin/mnemuron-admin.mjs bootstrap-admin
```

7. 把 Admin Key 保存到仅管理员可读的凭证文件，不写入仓库、shell 历史、聊天记录或服务日志。
8. 使用 Admin Key 注册两台 ChatGPT 实例并分别保存返回的 Key：

```bash
MNEMURON_DATABASE_PATH=/var/lib/mnemuron/mnemuron.sqlite3 \
MNEMURON_ADMIN_API_KEY="从受保护文件读取" \
  node /opt/mnemuron/server/bin/mnemuron-admin.mjs register-agent \
  --device example-device-a \
  --agent chatgpt \
  --instance chatgpt-example-a \
  --label "Device A ChatGPT"

MNEMURON_DATABASE_PATH=/var/lib/mnemuron/mnemuron.sqlite3 \
MNEMURON_ADMIN_API_KEY="从受保护文件读取" \
  node /opt/mnemuron/server/bin/mnemuron-admin.mjs register-agent \
  --device example-device-b \
  --agent chatgpt \
  --instance chatgpt-example-b \
  --label "Device B ChatGPT"
```

实际操作时不要把 Key 直接写在命令行；应从权限为 `0600` 的文件读取到进程环境，并避免输出。

9. 导入首轮测试 Task：

```bash
MNEMURON_DATABASE_PATH=/var/lib/mnemuron/mnemuron.sqlite3 \
MNEMURON_ADMIN_API_KEY="从受保护文件读取" \
  node /opt/mnemuron/server/bin/mnemuron-admin.mjs seed-task \
  --file /opt/mnemuron/server/seed/tasks.v0.1.json
```

## TLS 与网络

配置部署者自己的 HTTPS 域名与证书。本文使用 `https://mnemuron.example.com` 作为不可用于实际远程执行的占位符。

反向代理与服务同机时优先使用回环监听。分处不同主机时，需要显式配置服务监听地址，并限制后端端口仅供代理及获批管理来源访问。每台客户端只需能够访问相同 HTTPS 地址。

客户端默认拒绝明文 HTTP。`allow_insecure_http: true` 只用于临时隔离验证，不能作为原始对话的长期传输方案。

## 两台示例客户端的远端配置

每台 Mac 使用自己的 `~/.mnemuron/config.json` 和独立 Key 文件。Key 文件权限必须为 `0600`。

Device A：

```json
{
  "mode": "remote",
  "data_dir": "/Users/example/.mnemuron/client",
  "server_url": "https://mnemuron.example.com",
  "api_key_file": "/Users/example/.mnemuron/credentials/chatgpt-primary.key",
  "device_id": "example-device-a",
  "agent_id": "chatgpt",
  "agent_instance_id": "chatgpt-example-a",
  "raw_retention_days": 30,
  "default_project_id": "project-mnemuron",
  "default_task_id": "task-mnemuron-plugin-spike",
  "default_workstream_id": "workstream-device-a"
}
```

Device B：

```json
{
  "mode": "remote",
  "data_dir": "/Users/example/.mnemuron/client",
  "server_url": "https://mnemuron.example.com",
  "api_key_file": "/Users/example/.mnemuron/credentials/chatgpt-secondary.key",
  "device_id": "example-device-b",
  "agent_id": "chatgpt",
  "agent_instance_id": "chatgpt-example-b",
  "raw_retention_days": 30,
  "default_project_id": "project-mnemuron",
  "default_task_id": "task-mnemuron-plugin-spike",
  "default_workstream_id": "workstream-device-b"
}
```

若内网证书使用私有 CA，可增加：

```json
{
  "tls_ca_file": "/Users/example/.mnemuron/credentials/mnemuron-ca.pem"
}
```

## 验收顺序

1. 两端执行 `/Mnemuron 状态`，必须显示 `mode: remote-v0.1`、`server_reachable: true`、不同的 `server_verified` 身份，以及 `queued_events: 0`。
2. Device A 新建任务并产生一轮用户与 Assistant 消息。
3. Device B 输入“继续 Mnemuron plugin 任务”。
4. Preview 中必须出现来自 `example-device-a` / `chatgpt-example-a` 的最近活动。
5. Preview 中必须出现 Device A Workstream 的最新自动 Checkpoint，并显示版本、来源 Session、来源事件数、生成方法、可信标签和限制。
6. 未确认前响应中不得出现 Resume Packet。
7. 独立确认轮核对同一 `resume_id`、Preview 版本和当前 Hook-attested Session；该轮不返回可注入上下文。
8. 下一普通轮只投递一次同一版本 Packet，保持目标 Workstream，并由匹配 Stop 写入终态 ACK；后续轮不得重复投递。
9. 使用专用测试凭证验证撤销后请求失败且另一实例不受影响。
10. 重启服务，确认任务、事件、Checkpoint、Preview、Credential 与审计仍存在。

## 备份

在线备份使用 Node SQLite backup API：

```bash
MNEMURON_DATABASE_PATH=/var/lib/mnemuron/mnemuron.sqlite3 \
MNEMURON_ADMIN_API_KEY="从受保护文件读取" \
  node /opt/mnemuron/server/bin/mnemuron-admin.mjs backup \
  --file /var/lib/mnemuron/backups/mnemuron-YYYYMMDD.sqlite3
```

备份完成不等于恢复有效。首轮部署验收必须把备份复制到临时路径，用该副本启动一个隔离实例，并检查 `/readyz`、任务数量和恢复 Preview。

按实际环境安装并配置 `mnemuron-backup.timer`，然后验证：

- 按配置的日程执行，并核对主机时区与下一次运行时间。
- `Persistent=true`，关机错过后会补跑。
- 备份服务使用 `mnemuron` 非 root 用户，只能写入 `backups/scheduled`。
- 每份备份生成后执行 `PRAGMA integrity_check`，文件权限为 `0600`。
- 核对备份保留策略和容量；启用自动清理前明确其保留与恢复要求。

查看下一次运行时间或手动触发：

```bash
systemctl list-timers mnemuron-backup.timer --all
systemctl start mnemuron-backup.service
```

对指定备份执行隔离恢复验收：

```bash
/opt/mnemuron/node/bin/node \
  /opt/mnemuron/server/bin/mnemuron-restore-check.mjs \
  /var/lib/mnemuron/backups/scheduled/mnemuron-YYYYMMDDTHHMMSSZ.sqlite3 \
  /path/to/private/chatgpt-primary.key
```

恢复脚本把备份复制到临时目录，使用随机回环端口启动隔离实例，检查 SQLite 完整性、健康接口、服务端身份、Task、已确认 Resume Packet 和双端来源；无论成功或失败都清理临时恢复副本，不覆盖生产数据库。

## 自动化工具的显式参数

`server/install/bootstrap-lxc.sh` 要求显式提供 `MNEMURON_PRIMARY_DEVICE_ID`、`MNEMURON_PRIMARY_INSTANCE_ID`、`MNEMURON_SECONDARY_DEVICE_ID` 和 `MNEMURON_SECONDARY_INSTANCE_ID`，并生成 `chatgpt-primary.key` 与 `chatgpt-secondary.key`；可用 `MNEMURON_PRIMARY_KEY_FILE` 与 `MNEMURON_SECONDARY_KEY_FILE` 显式指定其他路径。现有部署必须沿用已核实的身份与凭证路径，不能直接套用新模板。这些身份应与客户端配置一致。

容量与故障测试的远程编排要求 `MNEMURON_PVE_HOST`、`MNEMURON_CTID` 和 `MNEMURON_SERVER_URL`。不要直接复制示例域名作为执行目标。凭证 smoke check 还要求 `MNEMURON_EXPECTED_DEVICE_ID` 与 `MNEMURON_EXPECTED_INSTANCE_ID`。

恢复检查要求 `MNEMURON_RESTORE_EXPECTED_IDENTITIES`，以逗号分隔至少两个 `instance@device`。必须使用待恢复部署的已知身份；不能从示例推断。OpenClaw/Hermes onboarding 的参数见各自 Adapter README。
