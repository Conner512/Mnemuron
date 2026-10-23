#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const databasePath = path.resolve(
  process.env.MNEMURON_DATABASE_PATH || "/var/lib/mnemuron/mnemuron.sqlite3",
);
const backupDir = path.resolve(
  process.env.MNEMURON_BACKUP_DIR || "/var/lib/mnemuron/backups/scheduled",
);
const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const target = path.join(backupDir, `mnemuron-${timestamp}.sqlite3`);
const temporary = `${target}.${process.pid}.tmp`;

function removeIfPresent(filePath) {
  if (existsSync(filePath)) unlinkSync(filePath);
}

mkdirSync(backupDir, { recursive: true, mode: 0o700 });
if (existsSync(target)) throw new Error(`Backup already exists: ${target}`);

let source;
let verified;
try {
  source = new DatabaseSync(databasePath, { readOnly: true });
  await backup(source, temporary);
  source.close();
  source = null;

  chmodSync(temporary, 0o600);
  verified = new DatabaseSync(temporary, { readOnly: true });
  const integrity = verified.prepare("PRAGMA integrity_check").get()?.integrity_check;
  const hasCheckpoints = Boolean(verified.prepare(`
    SELECT 1 AS present FROM sqlite_master
    WHERE type = 'table' AND name = 'checkpoints'
  `).get());
  const counts = verified.prepare(`
    SELECT
      (SELECT count(*) FROM events) AS events,
      (SELECT count(*) FROM memories) AS memories,
      (SELECT count(*) FROM tasks) AS tasks,
      (SELECT count(*) FROM resumes) AS resumes,
      (SELECT count(*) FROM credentials) AS credentials
  `).get();
  counts.checkpoints = hasCheckpoints
    ? verified.prepare("SELECT count(*) AS count FROM checkpoints").get().count
    : 0;
  verified.close();
  verified = null;

  if (integrity !== "ok") throw new Error(`Backup integrity check failed: ${integrity}`);
  removeIfPresent(`${temporary}-wal`);
  removeIfPresent(`${temporary}-shm`);
  renameSync(temporary, target);
  chmodSync(target, 0o600);

  process.stdout.write(`${JSON.stringify({
    status: "completed",
    backup_file: target,
    integrity_check: integrity,
    counts,
    retention: "no_automatic_deletion",
  })}\n`);
} finally {
  verified?.close();
  source?.close();
  removeIfPresent(temporary);
  removeIfPresent(`${temporary}-wal`);
  removeIfPresent(`${temporary}-shm`);
}
