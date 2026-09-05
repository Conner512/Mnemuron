#!/usr/bin/env node

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createMnemuronApp } from "../lib/app.mjs";

const backupFile = path.resolve(process.argv[2] || "");
const keyFile = path.resolve(process.argv[3] || "");
const restoreRoot = path.resolve(
  process.env.MNEMURON_RESTORE_ROOT || "/var/lib/mnemuron/restore-tests",
);
if (!process.argv[2] || !existsSync(backupFile)) throw new Error("backup file is required");
if (!process.argv[3] || !existsSync(keyFile)) throw new Error("API key file is required");
const expectedIdentities = (process.env.MNEMURON_RESTORE_EXPECTED_IDENTITIES || "")
  .split(",").map((value) => value.trim()).filter(Boolean);
if (new Set(expectedIdentities).size < 2) {
  throw new Error("MNEMURON_RESTORE_EXPECTED_IDENTITIES must list at least two distinct agent_instance_id@device_id values, separated by commas.");
}

function requestJson({ port, pathname, apiKey = null }) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method: "GET",
      timeout: 5000,
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve({ status: response.statusCode, body });
      });
    });
    request.on("timeout", () => request.destroy(new Error("restore check timed out")));
    request.on("error", reject);
    request.end();
  });
}

mkdirSync(restoreRoot, { recursive: true, mode: 0o700 });
const runDir = mkdtempSync(path.join(restoreRoot, "run-"));
const restoredDatabase = path.join(runDir, "mnemuron.sqlite3");
let app;
let listening = false;
let report;

try {
  copyFileSync(backupFile, restoredDatabase);
  chmodSync(restoredDatabase, 0o600);

  const restored = new DatabaseSync(restoredDatabase, { readOnly: true });
  const integrity = restored.prepare("PRAGMA integrity_check").get()?.integrity_check;
  const hasCheckpoints = Boolean(restored.prepare(`
    SELECT 1 AS present FROM sqlite_master
    WHERE type = 'table' AND name = 'checkpoints'
  `).get());
  const counts = restored.prepare(`
    SELECT
      (SELECT count(*) FROM events) AS events,
      (SELECT count(*) FROM memories) AS memories,
      (SELECT count(*) FROM tasks) AS tasks,
      (SELECT count(*) FROM resumes) AS resumes,
      (SELECT count(*) FROM credentials) AS credentials
  `).get();
  counts.checkpoints = hasCheckpoints
    ? restored.prepare("SELECT count(*) AS count FROM checkpoints").get().count
    : 0;
  const latestCheckpoint = hasCheckpoints ? restored.prepare(`
    SELECT checkpoint_id, task_id, workstream_id, session_id, version,
           source_event_ids_json, generation_method, confidence_label, created_at
    FROM checkpoints ORDER BY created_at DESC LIMIT 1
  `).get() : null;
  const latestResume = restored.prepare(`
    SELECT resume_id, preview_version, status, preview_json, packet_json
    FROM resumes
    WHERE status = 'confirmed' AND packet_json IS NOT NULL
    ORDER BY confirmed_at DESC LIMIT 1
  `).get();
  const latestTask = restored.prepare(`
    SELECT task_id, status, progress_json, blockers_json, next_steps_json, updated_at
    FROM tasks ORDER BY updated_at DESC LIMIT 1
  `).get();
  restored.close();

  if (integrity !== "ok") throw new Error(`Restore integrity check failed: ${integrity}`);
  if (!latestResume?.packet_json || latestResume.status !== "confirmed") {
    throw new Error("Latest confirmed Resume Packet is missing from restored data");
  }
  const preview = JSON.parse(latestResume.preview_json);
  const packet = JSON.parse(latestResume.packet_json);
  const identities = preview.source_summary?.identities || [];
  if (!expectedIdentities.every((identity) => identities.includes(identity))) {
    throw new Error("Restored Resume Preview is missing cross-device provenance");
  }
  if (packet.resume_id !== latestResume.resume_id ||
      packet.preview_version !== latestResume.preview_version) {
    throw new Error("Restored Resume Packet does not match its Preview");
  }
  if (!latestTask) throw new Error("Restored data does not contain a Task Checkpoint");

  app = createMnemuronApp({ databasePath: restoredDatabase });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  listening = true;
  const apiKey = readFileSync(keyFile, "utf8").trim();
  const livez = await requestJson({ port: address.port, pathname: "/livez" });
  const readyz = await requestJson({ port: address.port, pathname: "/readyz" });
  const status = await requestJson({
    port: address.port,
    pathname: "/v1/status",
    apiKey,
  });
  if (livez.status !== 200 || readyz.status !== 200 || status.status !== 200) {
    throw new Error("Isolated restored service did not pass HTTP health checks");
  }
  if (status.body.identity?.identity_status !== "server_verified") {
    throw new Error("Restored service did not verify the client identity");
  }

  report = {
    status: "passed",
    source_backup: backupFile,
    integrity_check: integrity,
    health: { livez: livez.status, readyz: readyz.status, api_status: status.status },
    identity: {
      device_id: status.body.identity.device_id,
      agent_instance_id: status.body.identity.agent_instance_id,
      identity_status: status.body.identity.identity_status,
    },
    counts,
    latest_task: {
      task_id: latestTask.task_id,
      status: latestTask.status,
      progress_items: JSON.parse(latestTask.progress_json).length,
      blockers: JSON.parse(latestTask.blockers_json).length,
      next_steps: JSON.parse(latestTask.next_steps_json).length,
      updated_at: latestTask.updated_at,
    },
    latest_resume: {
      resume_id: latestResume.resume_id,
      preview_version: latestResume.preview_version,
      status: latestResume.status,
      packet_id_matches: true,
      packet_version_matches: true,
      source_identities: identities,
    },
    latest_checkpoint: latestCheckpoint ? {
      checkpoint_id: latestCheckpoint.checkpoint_id,
      task_id: latestCheckpoint.task_id,
      workstream_id: latestCheckpoint.workstream_id,
      session_id: latestCheckpoint.session_id,
      version: latestCheckpoint.version,
      source_event_count: JSON.parse(latestCheckpoint.source_event_ids_json).length,
      generation_method: latestCheckpoint.generation_method,
      confidence_label: latestCheckpoint.confidence_label,
      created_at: latestCheckpoint.created_at,
    } : null,
  };
} finally {
  if (app && listening) await app.close();
  rmSync(runDir, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({
  ...report,
  isolation_removed: !existsSync(runDir),
})}\n`);
