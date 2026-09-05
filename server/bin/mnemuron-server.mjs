#!/usr/bin/env node

import path from "node:path";
import { createMnemuronApp } from "../lib/app.mjs";

const host = process.env.MNEMURON_HOST || "127.0.0.1";
const port = Number(process.env.MNEMURON_PORT || "47831");
const databasePath = path.resolve(
  process.env.MNEMURON_DATABASE_PATH || "/var/lib/mnemuron/mnemuron.sqlite3",
);
const defaultRetentionDays = process.env.MNEMURON_RAW_RETENTION_DAYS || "30";
const maxBodyBytes = Number(process.env.MNEMURON_MAX_BODY_BYTES || String(2 * 1024 * 1024));

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("MNEMURON_PORT must be a valid TCP port.");
}
if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 64 * 1024 || maxBodyBytes > 64 * 1024 * 1024) {
  throw new Error("MNEMURON_MAX_BODY_BYTES must be an integer from 65536 to 67108864.");
}

const app = createMnemuronApp({
  databasePath,
  defaultRetentionDays,
  maxBodyBytes,
  logger: (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`),
});

await app.listen({ host, port });
process.stdout.write(JSON.stringify({
  level: "info",
  message: "Mnemuron server listening",
  host,
  port,
  database_path: databasePath,
  max_body_bytes: maxBodyBytes,
}) + "\n");

let pruneContinuation=null;
function runPruneBatch() {
  pruneContinuation=null;
  try {
    const result = app.store.pruneExpired();
    if (result.expired_events) {
      process.stdout.write(JSON.stringify({ level: "info", action: "retention.prune", ...result }) + "\n");
    }
    if(result.more_pending) {
      pruneContinuation=setTimeout(runPruneBatch,1000);
      pruneContinuation.unref();
    }
  } catch (error) {
    process.stderr.write(JSON.stringify({ level: "error", action: "retention.prune", error: error.message }) + "\n");
  }
}
const pruneTimer = setInterval(() => {if(!pruneContinuation)runPruneBatch();}, 60 * 60_000);
pruneTimer.unref();

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  clearInterval(pruneTimer);
  if(pruneContinuation)clearTimeout(pruneContinuation);
  process.stdout.write(JSON.stringify({ level: "info", message: "Mnemuron server stopping", signal }) + "\n");
  await app.close();
}

process.on("SIGINT", () => shutdown("SIGINT").then(() => process.exit(0)));
process.on("SIGTERM", () => shutdown("SIGTERM").then(() => process.exit(0)));
