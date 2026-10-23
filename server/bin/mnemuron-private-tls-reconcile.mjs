#!/usr/bin/env node

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const [databasePath, runId] = process.argv.slice(2);
if (!databasePath || !runId) {
  throw new Error("Usage: mnemuron-private-tls-reconcile DATABASE RUN_ID");
}

const allowed = /^(?:body01|body02|body04|load01|load02|load03|load03large|queue01|queue03|queue04)-/;
const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  const rows = db.prepare("SELECT event_id FROM events WHERE event_id LIKE ? ORDER BY event_id")
    .all(`${runId}-%`)
    .filter((row) => allowed.test(row.event_id.slice(runId.length + 1)));
  const ids = rows.map((row) => row.event_id);
  const rejected = db.prepare("SELECT count(*) AS count FROM events WHERE event_id IN (?, ?)")
    .get(`${runId}-body03-000000`, `${runId}-queue04-000000`).count;
  const body01 = db.prepare("SELECT length(raw_payload_json) AS raw_bytes FROM events WHERE event_id = ?")
    .get(`${runId}-body01-000000`);
  const raw = db.prepare(`
    SELECT
      count(*) AS events,
      sum(CASE WHEN raw_payload_json IS NOT NULL THEN 1 ELSE 0 END) AS raw_available,
      sum(CASE WHEN expired_at IS NOT NULL THEN 1 ELSE 0 END) AS expired,
      sum(CASE WHEN raw_payload_json IS NULL AND expired_at IS NULL THEN 1 ELSE 0 END) AS unexplained
    FROM events
  `).get();
  const credential = db.prepare(`
    SELECT
      count(*) AS total,
      sum(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS active,
      sum(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked
    FROM credentials WHERE agent_instance_id = ?
  `).get(`mnemuron-loadgen-${runId}`);
  process.stdout.write(`${JSON.stringify({
    run_id: runId,
    stored: ids.length,
    stored_id_sha256: createHash("sha256").update(ids.join("\n")).digest("hex"),
    rejected_events_stored: rejected,
    body01_raw_bytes: body01?.raw_bytes || 0,
    integrity_check: db.prepare("PRAGMA integrity_check").get().integrity_check,
    raw_counts: raw,
    temporary_credential: credential,
  })}\n`);
} finally {
  db.close();
}
