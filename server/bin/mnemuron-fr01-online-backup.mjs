#!/usr/bin/env node

import { createReadStream } from "node:fs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

process.umask(0o077);

const [sourcePath, targetPath] = process.argv.slice(2);
if (!sourcePath || !targetPath) {
  throw new Error("Usage: mnemuron-fr01-online-backup SOURCE TARGET");
}

const source = path.resolve(sourcePath);
const target = path.resolve(targetPath);
const temporary = `${target}.${process.pid}.tmp`;
const cleanupSuffixes = ["", "-wal", "-shm", "-journal", ".tmp", ".tmp-wal", ".tmp-shm", ".tmp-journal"];

function cleanupTemporary() {
  for (const suffix of cleanupSuffixes) rmSync(`${temporary}${suffix}`, { force: true });
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
chmodSync(path.dirname(target), 0o700);
if (existsSync(target)) throw new Error(`Backup target already exists: ${target}`);
cleanupTemporary();

let sourceDatabase;
let verifiedDatabase;
try {
  sourceDatabase = new DatabaseSync(source, { readOnly: true });
  const pagesBackedUp = await backup(sourceDatabase, temporary);
  sourceDatabase.close();
  sourceDatabase = null;
  chmodSync(temporary, 0o600);

  verifiedDatabase = new DatabaseSync(temporary, { readOnly: true });
  const quickCheck = verifiedDatabase.prepare("PRAGMA quick_check").get().quick_check;
  const integrityCheck = verifiedDatabase.prepare("PRAGMA integrity_check").get().integrity_check;
  verifiedDatabase.close();
  verifiedDatabase = null;
  for (const suffix of cleanupSuffixes.slice(1)) rmSync(`${temporary}${suffix}`, { force: true });
  if (quickCheck !== "ok" || integrityCheck !== "ok") {
    throw new Error("Online backup failed SQLite verification.");
  }

  const bytes = statSync(temporary).size;
  const sha256 = await sha256File(temporary);
  renameSync(temporary, target);
  chmodSync(target, 0o600);
  const targetSidecars = cleanupSuffixes.slice(1).map((suffix) => `${target}${suffix}`);
  for (const file of targetSidecars) rmSync(file, { force: true });
  process.stdout.write(`${JSON.stringify({
    source,
    target,
    pages_backed_up: pagesBackedUp,
    bytes,
    mode: (statSync(target).mode & 0o777).toString(8).padStart(4, "0"),
    sha256,
    quick_check: quickCheck,
    integrity_check: integrityCheck,
    temporary_artifacts_remaining: [temporary, ...cleanupSuffixes.slice(1).map((suffix) => `${temporary}${suffix}`), ...targetSidecars]
      .filter((file) => existsSync(file)),
  })}\n`);
} catch (error) {
  try { sourceDatabase?.close(); } catch {}
  try { verifiedDatabase?.close(); } catch {}
  cleanupTemporary();
  throw error;
}
