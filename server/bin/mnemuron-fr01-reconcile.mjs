#!/usr/bin/env node

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const [databasePath, runId, agentInstanceId] = process.argv.slice(2);
if (!databasePath || !runId || !agentInstanceId) {
  throw new Error("Usage: mnemuron-fr01-reconcile DATABASE RUN_ID AGENT_INSTANCE_ID");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function aggregate(rows) {
  const ids = rows.map((row) => row.event_id);
  const distinct = (key) => [...new Set(rows.map((row) => row[key]))];
  return {
    count: rows.length,
    id_sha256: sha256(ids.join("\n")),
    raw_available: rows.filter((row) => row.raw_available === 1).length,
    distinct_credential_ids: distinct("credential_id"),
    distinct_device_ids: distinct("device_id"),
    distinct_agent_ids: distinct("agent_id"),
    distinct_agent_instance_ids: distinct("agent_instance_id"),
    distinct_project_ids: distinct("project_id"),
    distinct_task_ids: distinct("task_id"),
    distinct_workstream_ids: distinct("workstream_id"),
    distinct_session_ids: distinct("session_id"),
    unique_turn_ids: new Set(rows.map((row) => row.turn_id)).size,
    first_captured_at: rows[0]?.captured_at || null,
    last_captured_at: rows.at(-1)?.captured_at || null,
    first_received_at: rows[0]?.received_at || null,
    last_received_at: rows.at(-1)?.received_at || null,
  };
}

const database = new DatabaseSync(databasePath, { readOnly: true });
try {
  const rows = database.prepare(`
    SELECT event_id, credential_id, device_id, agent_id, agent_instance_id,
           project_id, task_id, workstream_id, session_id, turn_id,
           captured_at, received_at,
           CASE WHEN raw_payload_json IS NULL THEN 0 ELSE 1 END AS raw_available
    FROM events
    WHERE event_id LIKE ?
    ORDER BY event_id
  `).all(`${runId}-fr01-%`);
  const cycleRows = database.prepare(`
    SELECT event_id, credential_id, device_id, agent_id, agent_instance_id,
           project_id, task_id, workstream_id, session_id, turn_id,
           captured_at, received_at,
           CASE WHEN raw_payload_json IS NULL THEN 0 ELSE 1 END AS raw_available
    FROM events
    WHERE event_id LIKE ?
    ORDER BY event_id
  `);
  const raw = database.prepare(`
    SELECT count(*) AS events,
           sum(CASE WHEN raw_payload_json IS NOT NULL THEN 1 ELSE 0 END) AS raw_available,
           sum(CASE WHEN expired_at IS NOT NULL THEN 1 ELSE 0 END) AS expired,
           sum(CASE WHEN raw_payload_json IS NULL AND expired_at IS NULL THEN 1 ELSE 0 END) AS unexplained
    FROM events
  `).get();
  const credential = database.prepare(`
    SELECT credential_id, device_id, agent_id, agent_instance_id, scopes_json,
           created_at, expires_at, revoked_at
    FROM credentials
    WHERE agent_instance_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(agentInstanceId) || null;
  const receipts = database.prepare(`
    SELECT count(*) AS rows,
           sum(CASE WHEN phase = 'delivered' THEN 1 ELSE 0 END) AS delivered,
           sum(CASE WHEN phase = 'acknowledged' THEN 1 ELSE 0 END) AS acknowledged,
           sum(CASE WHEN phase = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM resume_delivery_receipts
  `).get();
  const injections = database.prepare(`
    SELECT count(*) AS rows,
           sum(CASE WHEN phase = 'injected' THEN 1 ELSE 0 END) AS injected,
           sum(CASE WHEN phase = 'acknowledged' THEN 1 ELSE 0 END) AS acknowledged,
           sum(CASE WHEN phase = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM resume_injection_events
  `).get();
  const cycles = {};
  for (const label of ["managed-1", "managed-2", "managed-3", "sigkill-1", "sigkill-2"]) {
    cycles[label] = aggregate(cycleRows.all(`${runId}-fr01-${label}-%`));
  }
  process.stdout.write(`${JSON.stringify({
    run_id: runId,
    target_events: aggregate(rows),
    cycles,
    credential: credential ? {
      credential_id: credential.credential_id,
      device_id: credential.device_id,
      agent_id: credential.agent_id,
      agent_instance_id: credential.agent_instance_id,
      scopes: JSON.parse(credential.scopes_json),
      created_at: credential.created_at,
      expires_at: credential.expires_at,
      revoked_at: credential.revoked_at,
    } : null,
    global: { raw, receipts, injections },
    quick_check: database.prepare("PRAGMA quick_check").get().quick_check,
    integrity_check: database.prepare("PRAGMA integrity_check").get().integrity_check,
  })}\n`);
} finally {
  database.close();
}
