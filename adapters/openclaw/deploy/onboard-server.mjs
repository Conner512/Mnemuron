#!/usr/bin/env node

import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { MnemuronStore, SCOPE_DEFAULTS } from "/opt/mnemuron/server/lib/store.mjs";

const databasePath = process.env.MNEMURON_DATABASE_PATH || "/var/lib/mnemuron/mnemuron.sqlite3";
const adminKeyFile = process.env.MNEMURON_ADMIN_KEY_FILE || "/root/.mnemuron/credentials/admin.key";
const agentKeyFile = process.env.MNEMURON_AGENT_KEY_FILE;
const deviceId = process.env.MNEMURON_DEVICE_ID;
const instanceId = process.env.MNEMURON_AGENT_INSTANCE_ID;
const seedFile = process.argv[2];

if (!seedFile) throw new Error("Task seed file path is required.");
if (!agentKeyFile || !deviceId || !instanceId) {
  throw new Error("MNEMURON_AGENT_KEY_FILE, MNEMURON_DEVICE_ID, and MNEMURON_AGENT_INSTANCE_ID are required.");
}

const store = new MnemuronStore(databasePath);
try {
  const admin = store.authenticate(readFileSync(adminKeyFile, "utf8").trim());
  let credential = store.db.prepare(`
    SELECT credential_id, device_id, agent_id, agent_instance_id
    FROM credentials
    WHERE user_id = ? AND agent_instance_id = ? AND revoked_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(admin.user_id, instanceId);
  let credentialAction = "existing";

  if (!credential) {
    if (existsSync(agentKeyFile)) {
      throw new Error("OpenClaw key file exists without an active credential; refusing to overwrite it.");
    }
    const issued = store.registerAgent(admin, {
      label: "OpenClaw client",
      device_id: deviceId,
      agent_id: "openclaw",
      agent_instance_id: instanceId,
      scopes: SCOPE_DEFAULTS.agent,
    });
    writeFileSync(agentKeyFile, `${issued.api_key}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(agentKeyFile, 0o600);
    credential = issued.credential;
    credentialAction = "created";
  } else if (!existsSync(agentKeyFile)) {
    throw new Error("Active OpenClaw credential exists but its recovery key file is missing.");
  }

  const task = JSON.parse(readFileSync(seedFile, "utf8"));
  const savedTask = store.upsertTask(admin, task);
  process.stdout.write(`${JSON.stringify({
    status: "completed",
    credential_action: credentialAction,
    credential_id: credential.credential_id,
    identity: {
      device_id: credential.device_id,
      agent_id: credential.agent_id,
      agent_instance_id: credential.agent_instance_id,
    },
    key_file_mode: statSync(agentKeyFile).mode & 0o777,
    task_id: savedTask.task_id,
    workstreams: savedTask.workstreams,
  }, null, 2)}\n`);
} finally {
  store.close();
}
